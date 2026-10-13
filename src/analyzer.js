// Descobre, para cada série da Fila, quais episódios você ainda não viu.
//
// Não confia no "A Seguir"/"never_watched" da Crunchyroll (justamente o que está
// falhando). Cruza a lista real de episódios com o seu histórico de reprodução
// (playheads) de TODAS as versões de áudio de cada episódio.
//
// Modo de áudio por série:
//  - "auto": qualquer versão conta; avisa assim que o episódio sair em qualquer áudio.
//  - "sub":  usa a versão original (legendada); avisa quando ela sair.
//  - "dub":  só avisa quando a versão dublada no seu idioma estiver liberada.
// Em todos os modos, ter assistido QUALQUER versão de um episódio conta como assistido.

/* global browser, CRApi */
var CRAnalyzer = (() => {
  const CACHE_KEY = "crnovos:v4:cache"; // v4: ignora registros de reprodução de menos de 1 minuto
  const CACHE_TTL = 20 * 60 * 1000;
  // Quantas séries são consultadas ao mesmo tempo (configurável na página).
  const CONCURRENCY = { default: 4, min: 1, max: 16 };
  const MAX_SEASONS_BACK = 6;
  const WATCHED_RATIO = 0.9;
  // A Crunchyroll cria registros de reprodução com poucos segundos (ou zero) só por
  // abrir a página do episódio ou pelo início automático do player. Abaixo disso, o
  // registro é ignorado: não conta como "já comecei a assistir".
  const MIN_STARTED_SECONDS = 60;

  // ---------- utilidades ----------
  function pickImage(images, wanted = 320) {
    if (!images) return null;
    const groups = images.thumbnail || images.poster_wide || images.poster_tall || [];
    const flat = groups.flat ? groups.flat(2) : [];
    if (!flat.length) return null;
    flat.sort((a, b) => Math.abs((a.width || 0) - wanted) - Math.abs((b.width || 0) - wanted));
    return flat[0].source || null;
  }

  function versionIds(ep) {
    const ids = new Set([ep.id]);
    for (const v of ep.versions || []) if (v.guid) ids.add(v.guid);
    return [...ids];
  }

  function isAvailable(ep, now) {
    if (ep.is_clip) return false;
    if (ep.availability_status && ep.availability_status !== "available") return false;
    const start = Date.parse(ep.availability_starts || ep.premium_available_date || "");
    if (start && start > now) return false;
    return true;
  }

  // O episódio está mesmo neste áudio? Atenção: a lista de episódios da temporada
  // dublada pode trazer episódios no áudio original quando a dublagem ainda não saiu
  // (ex.: Saga of Tanya the Evil T2, lista pt-BR, episódio 12 em ja-JP). Por isso o
  // que vale é o áudio do próprio episódio, não o da lista.
  function isInAudio(ep, audio) {
    if (ep.audio_locale) return ep.audio_locale === audio;
    return (ep.versions || []).some((v) => v.guid === ep.id && v.audio_locale === audio);
  }

  const originalVersion = (obj) => (obj.versions || []).find((v) => v.original);
  const seasonKey = (s) => (originalVersion(s) && originalVersion(s).guid) || s.id;

  // ID da temporada que tem o áudio pedido (ou null se esse áudio não existe nela).
  function seasonIdForAudio(season, audio) {
    if (season.audio_locale === audio) return season.id;
    const v = (season.versions || []).find((x) => x.audio_locale === audio);
    if (v) return v.guid;
    if ((season.audio_locales || []).includes(audio) && !(season.versions || []).length) return season.id;
    return null;
  }

  function sortSeasons(list) {
    const seen = new Set();
    const unique = [];
    for (const s of list) {
      const k = seasonKey(s);
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(s);
    }
    return unique.sort(
      (a, b) =>
        (a.season_sequence_number ?? a.season_number ?? 0) -
          (b.season_sequence_number ?? b.season_number ?? 0) ||
        (a.season_number ?? 0) - (b.season_number ?? 0)
    );
  }

  function concurrencyFrom(settings) {
    const raw = settings ? settings.concurrency : undefined;
    if (raw === undefined || raw === null || String(raw).trim() === "") return CONCURRENCY.default;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return CONCURRENCY.default;
    return Math.min(CONCURRENCY.max, Math.max(CONCURRENCY.min, n));
  }

  async function pool(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const run = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  }

  // ---------- cache ----------
  async function loadCache(accountId) {
    const all = (await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
    return all[accountId] || {};
  }
  async function saveCache(accountId, cache) {
    const all = (await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
    all[accountId] = cache;
    await browser.storage.local.set({ [CACHE_KEY]: all });
  }
  const cacheSignature = (mode, settings) => `${mode}|${mode === "dub" ? settings.dubLang : ""}|${settings.locale}`;

  // ---------- Fila ----------
  function normalizeItem(item) {
    const p = item.panel || {};
    const meta = p.episode_metadata || {};
    if (p.type === "movie_listing" || p.type === "movie") return null;
    const seriesId = p.type === "series" ? p.id : meta.series_id || p.series_id;
    if (!seriesId) return null;
    return {
      seriesId,
      title: p.type === "series" ? p.title : meta.series_title || p.title,
      slug: p.type === "series" ? p.slug_title : meta.series_slug_title || "",
      image: pickImage(p.images, 320),
      neverWatchedFlag: !!item.never_watched,
    };
  }

  // ---------- análise de uma série ----------
  async function analyzeSeries(entry, mode, settings, api = CRApi) {
    const now = Date.now();
    const { locale, dubLang } = settings;
    const seasons = sortSeasons(await api.seasons(entry.seriesId, locale));

    const ordered = [];
    let anyActivity = false;
    let dubMissingSomewhere = false;
    let waitingDubLatest = 0;
    // Modo dublado: a temporada mais recente tem algum episódio no idioma escolhido?
    // null = ainda não examinada. false = não tem nenhum ("sem dublagem", não
    // "aguardando": a dublagem pode nunca sair).
    let latestHasDub = null;

    for (let i = seasons.length - 1, back = 0; i >= 0 && back < MAX_SEASONS_BACK; i--, back++) {
      const season = seasons[i];

      // Qual lista de episódios usar para esta temporada, conforme o modo.
      let listId = season.id;
      let eligible = true;
      if (mode === "sub") {
        listId = (originalVersion(season) && originalVersion(season).guid) || season.id;
      } else if (mode === "dub") {
        const dubId = seasonIdForAudio(season, dubLang);
        if (dubId) listId = dubId;
        else {
          eligible = false; // sem dublagem: serve só para saber o que você já viu
          dubMissingSomewhere = true;
        }
      }

      let eps = await api.episodes(listId, locale);
      if (!eps.length && listId !== season.id) {
        eps = await api.episodes(season.id, locale);
        if (mode === "dub") {
          eligible = false;
          dubMissingSomewhere = true;
        }
      }
      eps = eps
        .filter((e) => !e.is_clip)
        .sort((a, b) => (a.sequence_number ?? 0) - (b.sequence_number ?? 0));
      if (!eps.length) continue;

      if (mode === "dub" && latestHasDub === null) {
        latestHasDub = eligible && eps.some((e) => isInAudio(e, dubLang));
      }

      const ids = [];
      for (const ep of eps) ids.push(...versionIds(ep));
      // Modo dublado, temporada mais recente: episódios que já saíram no áudio
      // original mas ainda não têm dublagem lançada ("aguardando dublagem").
      let origOnly = [];
      if (mode === "dub" && eligible && back === 0) {
        const origId = (originalVersion(season) && originalVersion(season).guid) || season.id;
        if (origId !== listId) {
          const dubbedSeqs = eps
            .filter((e) => isInAudio(e, dubLang) && isAvailable(e, now))
            .map((e) => e.sequence_number ?? 0);
          const lastDubSeq = Math.max(-Infinity, ...dubbedSeqs);
          // Episódios que aparecem na lista dublada mas no áudio original já são
          // contados no laço principal; aqui ficam os demais (inclusive os que têm
          // dublagem agendada para o futuro).
          const inList = new Set(
            eps.filter((e) => !isInAudio(e, dubLang)).map((e) => e.sequence_number ?? 0)
          );
          origOnly = (await api.episodes(origId, locale)).filter(
            (e) =>
              !e.is_clip &&
              (e.sequence_number ?? 0) > lastDubSeq &&
              !inList.has(e.sequence_number ?? 0) &&
              isAvailable(e, now)
          );
          for (const e of origOnly) ids.push(...versionIds(e));
        }
      }

      const ph = await api.playheads(ids, locale);
      const seen = (e) => versionIds(e).some((id) => ph.get(id) && ph.get(id).fully_watched);
      waitingDubLatest += origOnly.filter((e) => !seen(e)).length;

      const states = eps.map((ep) => {
        const durSec = (ep.duration_ms || 0) / 1000;
        let fully = false;
        let started = false;
        let maxPos = 0;
        let lastMod = 0;
        let lastId = null;
        for (const id of versionIds(ep)) {
          const p = ph.get(id);
          if (!p) continue;
          if (!p.fully_watched && (p.playhead || 0) < MIN_STARTED_SECONDS) continue;
          started = true;
          maxPos = Math.max(maxPos, p.playhead || 0);
          if (p.fully_watched) fully = true;
          const mod = Date.parse(p.last_modified || "") || 0;
          if (mod >= lastMod) {
            lastMod = mod;
            lastId = id;
          }
        }
        if (durSec && maxPos >= durSec * WATCHED_RATIO) fully = true;
        const progress = durSec ? Math.min(1, maxPos / durSec) : 0;
        // No modo dublado, só conta o episódio que está de fato no áudio escolhido.
        const epEligible = eligible && (mode !== "dub" || isInAudio(ep, dubLang));
        return { ep, season, eligible: epEligible, fully, started, progress, lastMod, lastId };
      });

      ordered.unshift(...states);
      if (states.some((s) => s.started)) {
        anyActivity = true;
        break;
      }
      if (entry.neverWatchedFlag && back >= 1) break;
    }

    const base = { ...entry, mode, checkedAt: now, signature: cacheSignature(mode, settings) };
    if (!anyActivity) return { ...base, status: "never", pending: [] };

    let lastIdx = -1;
    for (let i = 0; i < ordered.length; i++) if (ordered[i].started) lastIdx = i;
    const last = ordered[lastIdx];

    const pending = [];
    let waitingDub = 0;
    for (let i = lastIdx; i < ordered.length; i++) {
      const s = ordered[i];
      if (s.fully) continue;
      if (!s.eligible) {
        if (mode === "dub" && isAvailable(s.ep, now)) waitingDub++;
        continue;
      }
      if (!isAvailable(s.ep, now)) continue;

      const ep = s.ep;
      // sub/dub: a própria lista já está no áudio certo. No modo "qualquer áudio",
      // um episódio começado abre na versão em que você parou; os demais abrem na
      // versão listada (a de outro áudio pode ainda não ter sido lançada).
      let targetId = ep.id;
      if (mode === "auto" && s.started && s.lastId) targetId = s.lastId;
      pending.push({
        id: targetId,
        slug: ep.slug_title || "",
        title: ep.title || "",
        season: ep.season_number,
        seasonTitle: s.season.title || ep.season_title || "",
        number: ep.episode || (ep.episode_number != null ? String(ep.episode_number) : ""),
        thumb: pickImage(ep.images, 320),
        inProgress: s.started && !s.fully,
        progress: s.progress,
        availableAt: Date.parse(ep.availability_starts || ep.premium_available_date || "") || 0,
      });
    }

    return {
      ...base,
      image: base.image || (pending[0] && pending[0].thumb) || null,
      status: pending.length ? "pending" : "uptodate",
      pending,
      waitingDub: waitingDub + waitingDubLatest,
      dubMissing: mode === "dub" && dubMissingSomewhere,
      noDub: mode === "dub" && latestHasDub === false,
      lastWatchedAt: last.lastMod || 0,
    };
  }

  const modeFor = (seriesId, settings) => settings.seriesModes[seriesId] || settings.defaultMode;

  async function analyzeSafe(entry, settings) {
    const mode = modeFor(entry.seriesId, settings);
    try {
      return await analyzeSeries(entry, mode, settings);
    } catch (err) {
      console.warn("[Novos Episódios]", entry.title, err);
      return { ...entry, mode, status: "error", error: String(err.message || err), pending: [] };
    }
  }

  // ---------- execução completa ----------
  async function run({ settings, force = false, onProgress = () => {} }) {
    const accountId = await CRApi.getAccountId();
    const items = (await CRApi.watchlist(settings.locale)).map(normalizeItem).filter(Boolean);
    const unique = [...new Map(items.map((i) => [i.seriesId, i])).values()];

    const cache = force ? {} : await loadCache(accountId);
    let done = 0;
    onProgress(done, unique.length);

    const results = await pool(unique, concurrencyFrom(settings), async (entry) => {
      const sig = cacheSignature(modeFor(entry.seriesId, settings), settings);
      const hit = cache[entry.seriesId];
      let result;
      if (hit && hit.signature === sig && Date.now() - hit.checkedAt < CACHE_TTL) {
        result = { ...hit, title: entry.title, image: hit.image || entry.image };
      } else {
        result = await analyzeSafe(entry, settings);
        if (result.status !== "error") cache[entry.seriesId] = result;
      }
      onProgress(++done, unique.length);
      return result;
    });

    // Remove do cache séries que saíram da Fila.
    const keep = new Set(unique.map((u) => u.seriesId));
    for (const id of Object.keys(cache)) if (!keep.has(id)) delete cache[id];
    await saveCache(accountId, cache);
    return results;
  }

  // ---------- diagnóstico ----------
  // Chaves que nunca vão para o arquivo de diagnóstico, em qualquer nível.
  const SENSITIVE_KEY = /token|cookie|authorization|password|secret|etp_rt|account_id|profile_id|email/i;

  function sanitize(value) {
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (SENSITIVE_KEY.test(k)) continue;
        out[k] = sanitize(v);
      }
      return out;
    }
    return value;
  }

  // Envolve a API gravando as respostas exatamente como chegaram.
  function recordingApi(base, log) {
    return {
      async seasons(id, locale) {
        const r = await base.seasons(id, locale);
        log.temporadas[id] = r;
        return r;
      },
      async episodes(id, locale) {
        const r = await base.episodes(id, locale);
        log.episodios[id] = r;
        return r;
      },
      async playheads(ids, locale) {
        const m = await base.playheads(ids, locale);
        for (const [k, v] of m) log.playheads[k] = v;
        return m;
      },
    };
  }

  // Reanalisa uma série gravando tudo o que a análise usou. O arquivo não contém
  // token, cookie nem IDs de conta ou perfil: só catálogo e histórico da série.
  async function diagnose(entry, settings, { version = "", api = CRApi } = {}) {
    const mode = modeFor(entry.seriesId, settings);
    const log = { temporadas: {}, episodios: {}, playheads: {} };
    let resultado;
    try {
      resultado = await analyzeSeries(entry, mode, settings, recordingApi(api, log));
    } catch (err) {
      resultado = { status: "error", error: String(err.message || err) };
    }
    return sanitize({
      tipo: "crnovos-diagnostico",
      formato: 1,
      versaoExtensao: version,
      geradoEm: new Date().toISOString(),
      configuracao: {
        modo: mode,
        dubLang: settings.dubLang,
        locale: settings.locale,
      },
      serie: entry,
      resultado,
      respostas: {
        temporadas: log.temporadas,
        episodios: log.episodios,
        playheads: Object.values(log.playheads),
      },
    });
  }

  // Reanalisa uma série só (ex.: depois de trocar o modo de áudio dela).
  async function runOne(entry, settings) {
    const accountId = await CRApi.getAccountId();
    const result = await analyzeSafe(entry, settings);
    if (result.status !== "error") {
      const cache = await loadCache(accountId);
      cache[entry.seriesId] = result;
      await saveCache(accountId, cache);
    }
    return result;
  }

  return { run, runOne, diagnose, sanitize, CONCURRENCY, concurrencyFrom, MIN_STARTED_SECONDS };
})();
