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
  const CACHE_KEY = "crnovos:v2:cache";
  const CACHE_TTL = 20 * 60 * 1000;
  const CONCURRENCY = 4;
  const MAX_SEASONS_BACK = 6;
  const WATCHED_RATIO = 0.9;

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
  async function analyzeSeries(entry, mode, settings) {
    const now = Date.now();
    const { locale, dubLang } = settings;
    const seasons = sortSeasons(await CRApi.seasons(entry.seriesId, locale));

    const ordered = [];
    let anyActivity = false;
    let dubMissingSomewhere = false;
    let waitingDubLatest = 0;

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

      let eps = await CRApi.episodes(listId, locale);
      if (!eps.length && listId !== season.id) {
        eps = await CRApi.episodes(season.id, locale);
        if (mode === "dub") {
          eligible = false;
          dubMissingSomewhere = true;
        }
      }
      eps = eps
        .filter((e) => !e.is_clip)
        .sort((a, b) => (a.sequence_number ?? 0) - (b.sequence_number ?? 0));
      if (!eps.length) continue;

      const ids = [];
      for (const ep of eps) ids.push(...versionIds(ep));
      // Modo dublado, temporada mais recente: episódios que já saíram no áudio
      // original mas ainda não têm dublagem lançada ("aguardando dublagem").
      let origOnly = [];
      if (mode === "dub" && eligible && back === 0) {
        const origId = (originalVersion(season) && originalVersion(season).guid) || season.id;
        if (origId !== listId) {
          const lastDubSeq = Math.max(
            -Infinity,
            ...eps.filter((e) => isAvailable(e, now)).map((e) => e.sequence_number ?? 0)
          );
          origOnly = (await CRApi.episodes(origId, locale)).filter(
            (e) => !e.is_clip && (e.sequence_number ?? 0) > lastDubSeq && isAvailable(e, now)
          );
          for (const e of origOnly) ids.push(...versionIds(e));
        }
      }

      const ph = await CRApi.playheads(ids, locale);
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
        return { ep, season, eligible, fully, started, progress, lastMod, lastId };
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

    const results = await pool(unique, CONCURRENCY, async (entry) => {
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

  return { run, runOne };
})();
