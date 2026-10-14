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
  const CACHE_TTL = 20 * 60 * 1000; // dentro disso: reaproveita sem nenhuma consulta
  const REVALIDATE_TTL = 6 * 60 * 60 * 1000; // até isso: reaproveita se nada mudou
  // Quantas séries são consultadas ao mesmo tempo (configurável na página).
  const CONCURRENCY = { default: 4, min: 1, max: 32 };
  // Tamanho do lote (configurável na página): quantos IDs de episódio vão em cada
  // consulta de playheads e quantas séries vêm em cada página da Fila.
  // O limite real da API não é documentado; se a Crunchyroll recusar, diminua.
  const PLAYHEAD_BATCH = { default: 100, min: 10, max: 300 };
  const MAX_SEASONS_BACK = 6;
  const WATCHED_RATIO = 0.9;
  // A Crunchyroll cria registros de reprodução com poucos segundos (ou zero) só por
  // abrir a página do episódio ou pelo início automático do player. Abaixo disso, o
  // registro é ignorado: não conta como "já comecei a assistir".
  // Configurável na página (Configurações → Contar como começado a partir de).
  const MIN_STARTED = { default: 60, min: 0, max: 600 };
  const MIN_STARTED_SECONDS = MIN_STARTED.default;

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

  // O episódio tem legenda no idioma pedido? Sem a lista de legendas na resposta,
  // considera que sim (melhor anunciar do que esconder sem motivo). Se o áudio já
  // está no idioma, não precisa de legenda.
  function hasSubtitle(ep, lang) {
    if (ep.audio_locale === lang) return true;
    if (!Array.isArray(ep.subtitle_locales)) return true;
    return ep.subtitle_locales.includes(lang);
  }

  // ---------- especiais e recapitulações ----------
  const SPECIAL_SEASON = /\b(specials?|especia(?:l|is)|ovas?|oads?|extras?)\b/i;
  const RECAP_TITLE = /\b(recap|recapitula[çc][ãa]o|resumo)\b/i;

  function isSpecialSeason(season) {
    return season.season_number === 0 || SPECIAL_SEASON.test(season.title || "");
  }

  // "especial" (numeração fora do normal ou temporada especial), "recap" ou null.
  function extraKind(ep, season) {
    if (season && isSpecialSeason(season)) return "especial";
    const num = String(ep.episode ?? "").trim();
    if (num && !/^\d+$/.test(num)) return "especial"; // 13.5, SP, OVA...
    if (!num && ep.episode_number == null) return "especial";
    if (RECAP_TITLE.test(ep.title || "")) return "recap";
    return null;
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
    // Temporadas especiais vão antes das normais: a busca começa pela temporada
    // normal mais recente e não fica presa numa temporada de especiais.
    return unique.sort(
      (a, b) =>
        Number(isSpecialSeason(b)) - Number(isSpecialSeason(a)) ||
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

  function playheadBatchFrom(settings) {
    const raw = settings ? settings.playheadBatch : undefined;
    if (raw === undefined || raw === null || String(raw).trim() === "") return PLAYHEAD_BATCH.default;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return PLAYHEAD_BATCH.default;
    return Math.min(PLAYHEAD_BATCH.max, Math.max(PLAYHEAD_BATCH.min, n));
  }

  function minStartedFrom(settings) {
    const raw = settings ? settings.minStartedSeconds : undefined;
    if (raw === undefined || raw === null || String(raw).trim() === "") return MIN_STARTED.default;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return MIN_STARTED.default;
    return Math.min(MIN_STARTED.max, Math.max(MIN_STARTED.min, n));
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
  const cacheSignature = (mode, settings) =>
    [
      mode,
      mode === "dub" ? settings.dubLang : "",
      mode === "sub" ? settings.subLang || "pt-BR" : "",
      settings.locale,
      settings.showExtras === false ? "sem-extras" : "",
      settings.showSkipped ? "com-pulados" : "",
      minStartedFrom(settings),
    ].join("|");

  // ---------- Fila ----------
  function normalizeItem(item) {
    const p = item.panel || {};
    const meta = p.episode_metadata || {};
    if (p.type === "movie_listing" || p.type === "movie") {
      const mm = p.movie_metadata || {};
      const listingId = p.type === "movie_listing" ? p.id : mm.movie_listing_id || p.movie_listing_id || p.listing_id;
      if (!listingId) return null;
      return {
        kind: "movie",
        seriesId: listingId,
        title: p.type === "movie_listing" ? p.title : mm.movie_listing_title || p.movie_listing_title || p.title,
        slug: p.type === "movie_listing" ? p.slug_title : mm.movie_listing_slug_title || p.slug_title || "",
        image: pickImage(p.images, 320),
        neverWatchedFlag: !!item.never_watched,
      };
    }
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
  // Impressão digital das temporadas: muda quando entra temporada, episódio ou versão.
  const seasonsKey = (list) =>
    sortSeasons(list || [])
      .map((x) => `${x.id}:${x.number_of_episodes ?? ""}:${(x.versions || []).length}`)
      .join("|");

  async function analyzeSeries(entry, mode, settings, api = CRApi, prefetchedSeasons = null) {
    const now = Date.now();
    const { locale, dubLang } = settings;
    const subLang = settings.subLang || "pt-BR";
    const minStarted = minStartedFrom(settings);
    const rawSeasons = prefetchedSeasons || (await api.seasons(entry.seriesId, locale));
    const seasons = sortSeasons(rawSeasons);

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
          if (!p.fully_watched && (p.playhead || 0) < minStarted) continue;
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
        // Dublado: só conta o episódio que está de fato no áudio escolhido.
        // Legendado: só conta se já tiver legenda no idioma escolhido.
        const audioOk = mode !== "dub" || isInAudio(ep, dubLang);
        const subOk = mode !== "sub" || hasSubtitle(ep, subLang);
        return {
          ep,
          season,
          eligible: eligible && audioOk && subOk,
          missingSub: eligible && audioOk && !subOk,
          fully,
          started,
          progress,
          lastMod,
          lastId,
        };
      });

      ordered.unshift(...states);
      if (states.some((s) => s.started)) {
        anyActivity = true;
        break;
      }
      if (entry.neverWatchedFlag && back >= 1) break;
    }

    const base = {
      ...entry,
      mode,
      checkedAt: now,
      signature: cacheSignature(mode, settings),
      fp: { seasons: seasonsKey(rawSeasons) },
    };
    if (!anyActivity) return { ...base, status: "never", pending: [] };

    let lastIdx = -1;
    for (let i = 0; i < ordered.length; i++) if (ordered[i].started) lastIdx = i;
    const last = ordered[lastIdx];

    const toPending = (s, flags = {}) => {
      const ep = s.ep;
      // sub/dub: a própria lista já está no áudio certo. No modo "qualquer áudio",
      // um episódio começado abre na versão em que você parou; os demais abrem na
      // versão listada (a de outro áudio pode ainda não ter sido lançada).
      let targetId = ep.id;
      if (mode === "auto" && s.started && s.lastId) targetId = s.lastId;
      return {
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
        extra: flags.extra || null, // "especial"/"recap": fora das contagens
        skipped: !!flags.skipped, // anterior ao último visto: fora das contagens
      };
    };

    const pending = [];
    let waitingDub = 0;
    let waitingSub = 0;

    // Opcional: episódios antes do último visto que ficaram sem ver ("pulados").
    if (settings.showSkipped) {
      for (let i = 0; i < lastIdx; i++) {
        const s = ordered[i];
        if (s.fully || !s.eligible || !isAvailable(s.ep, now) || extraKind(s.ep, s.season)) continue;
        pending.push(toPending(s, { skipped: true }));
      }
    }
    for (let i = lastIdx; i < ordered.length; i++) {
      const s = ordered[i];
      if (s.fully) continue;
      if (!s.eligible) {
        if (isAvailable(s.ep, now)) {
          if (s.missingSub) waitingSub++;
          else if (mode === "dub") waitingDub++;
        }
        continue;
      }
      if (!isAvailable(s.ep, now)) continue;

      const kind = extraKind(s.ep, s.season);
      if (kind && settings.showExtras === false) continue;
      pending.push(toPending(s, { extra: kind }));
    }

    return {
      ...base,
      image: base.image || (pending[0] && pending[0].thumb) || null,
      status: pending.length ? "pending" : "uptodate",
      pending,
      next: nextRelease(ordered, mode, dubLang, now),
      waitingDub: waitingDub + waitingDubLatest,
      waitingSub,
      dubMissing: mode === "dub" && dubMissingSomewhere,
      noDub: mode === "dub" && latestHasDub === false,
      lastWatchedAt: last.lastMod || 0,
    };
  }

  // ---------- filmes ----------
  // Um título de filme tem uma versão por áudio; cada versão tem sua lista de filmes
  // (em geral um só, às vezes em partes). Para saber se você viu em qualquer áudio,
  // busca os filmes de todas as versões e alinha pela posição.
  async function analyzeMovie(entry, mode, settings, api = CRApi) {
    const now = Date.now();
    const { locale, dubLang } = settings;
    const minStarted = minStartedFrom(settings);
    const listing = (await api.movieListing(entry.seriesId, locale)) || { id: entry.seriesId, versions: [] };
    const versions = (listing.versions || []).length
      ? listing.versions
      : [{ guid: listing.id, audio_locale: listing.audio_locale, original: true }];

    const lists = [];
    for (const v of versions) {
      const items = (await api.movies(v.guid, locale)).filter((m) => !m.is_clip);
      lists.push({ audio: v.audio_locale, original: !!v.original, items });
    }
    const original = lists.find((l) => l.original) || lists[0];
    let target = original;
    let noDub = false;
    if (mode === "dub") {
      const dub = lists.find((l) => l.audio === dubLang && l.items.length);
      if (dub) target = dub;
      else noDub = true;
    } else if (mode === "auto") {
      target = lists.find((l) => l.items.length) || original;
    }

    const count = Math.max(0, ...lists.map((l) => l.items.length));
    const idsAt = (i) => lists.map((l) => l.items[i] && l.items[i].id).filter(Boolean);
    const ph = await api.playheads(
      Array.from({ length: count }, (_, i) => idsAt(i)).flat(),
      locale
    );

    const states = [];
    for (let i = 0; i < count; i++) {
      const movie = (target.items[i] || original.items[i] || lists.find((l) => l.items[i]).items[i]);
      const durSec = (movie.duration_ms || 0) / 1000;
      let fully = false;
      let started = false;
      let maxPos = 0;
      let lastMod = 0;
      for (const id of idsAt(i)) {
        const p = ph.get(id);
        if (!p) continue;
        if (!p.fully_watched && (p.playhead || 0) < minStarted) continue;
        started = true;
        maxPos = Math.max(maxPos, p.playhead || 0);
        if (p.fully_watched) fully = true;
        lastMod = Math.max(lastMod, Date.parse(p.last_modified || "") || 0);
      }
      if (durSec && maxPos >= durSec * WATCHED_RATIO) fully = true;
      states.push({ movie, fully, started, progress: durSec ? Math.min(1, maxPos / durSec) : 0, lastMod });
    }

    const base = {
      ...entry,
      kind: "movie",
      mode,
      checkedAt: now,
      signature: cacheSignature(mode, settings),
      noDub: mode === "dub" && noDub,
      waitingDub: 0,
      waitingSub: 0,
    };
    if (!states.some((s) => s.started)) return { ...base, status: "never", pending: [] };

    const firstOpen = states.findIndex((s) => !s.fully);
    const pending = [];
    if (firstOpen >= 0) {
      for (const s of states.slice(firstOpen)) {
        if (s.fully || !isAvailable(s.movie, now)) continue;
        pending.push({
          id: s.movie.id,
          slug: s.movie.slug_title || "",
          title: s.movie.title || entry.title,
          kind: "movie",
          season: null,
          number: "",
          thumb: pickImage(s.movie.images, 320),
          inProgress: s.started && !s.fully,
          progress: s.progress,
          availableAt: Date.parse(s.movie.premium_available_date || s.movie.availability_starts || "") || 0,
          extra: null,
          skipped: false,
        });
      }
    }
    return {
      ...base,
      image: base.image || (pending[0] && pending[0].thumb) || null,
      status: pending.length ? "pending" : "uptodate",
      pending,
      lastWatchedAt: Math.max(0, ...states.map((s) => s.lastMod)),
    };
  }

  // Próximo lançamento agendado no modo de áudio da série (null se não houver).
  // Datas absurdas (a Crunchyroll usa 9998-… para "sem data") são ignoradas.
  const MAX_FUTURE = 2 * 365 * 86400000;
  function nextRelease(ordered, mode, dubLang, now) {
    let best = null;
    for (const s of ordered) {
      if (s.fully) continue;
      if (mode === "dub" && !isInAudio(s.ep, dubLang)) continue;
      const at = Date.parse(s.ep.availability_starts || s.ep.premium_available_date || "");
      if (!at || at <= now || at - now > MAX_FUTURE) continue;
      if (!best || at < best.at) {
        best = {
          at,
          id: s.ep.id,
          season: s.ep.season_number,
          number: s.ep.episode || (s.ep.episode_number != null ? String(s.ep.episode_number) : ""),
          title: s.ep.title || "",
        };
      }
    }
    return best;
  }

  const analyzeEntry = (entry, mode, settings, api = CRApi, prefetchedSeasons = null) =>
    entry.kind === "movie"
      ? analyzeMovie(entry, mode, settings, api)
      : analyzeSeries(entry, mode, settings, api, prefetchedSeasons);

  const modeFor = (seriesId, settings) => settings.seriesModes[seriesId] || settings.defaultMode;

  async function analyzeSafe(entry, settings, prefetchedSeasons = null) {
    const mode = modeFor(entry.seriesId, settings);
    try {
      return await analyzeEntry(entry, mode, settings, CRApi, prefetchedSeasons);
    } catch (err) {
      console.warn("[Novos Episódios]", entry.title, err);
      return { ...entry, mode, status: "error", error: String(err.message || err), pending: [] };
    }
  }

  // ---------- execução completa ----------
  // Cache separado por conta e perfil (o histórico é do perfil).
  async function cacheScope() {
    const accountId = await CRApi.getAccountId();
    const profileId = CRApi.getProfileId ? await CRApi.getProfileId() : "";
    return profileId ? `${accountId}:${profileId}` : accountId;
  }

  // Séries/filmes com atividade real no histórico (parent_id -> último play).
  // Registros curtos (abaixo do limite de "começado") não contam.
  function historyActivity(history, settings) {
    const map = new Map();
    if (!history) return map;
    const min = minStartedFrom(settings);
    for (const h of history.entries || []) {
      if (!h || !h.parent_id) continue;
      if (!h.fully_watched && (h.playhead || 0) < min) continue;
      const at = Date.parse(h.date_played || "") || 0;
      map.set(h.parent_id, Math.max(map.get(h.parent_id) || 0, at));
    }
    return map;
  }

  async function loadHistory(settings) {
    if (!CRApi.watchHistory) return null;
    try {
      return await CRApi.watchHistory(settings.locale, { parallel: concurrencyFrom(settings) });
    } catch (err) {
      console.warn("[Novos Episódios] histórico indisponível, seguindo sem ele:", err);
      return null;
    }
  }

  // Atalho seguro para "nunca assistida": o histórico foi lido até o fim, a série
  // não aparece nele com atividade E a própria Crunchyroll diz never_watched.
  const surelyNever = (entry, history, activity) =>
    !!(history && history.complete && entry.neverWatchedFlag && !activity.has(entry.seriesId));

  async function run({ settings, force = false, onProgress = () => {} }) {
    if (CRApi.setPlayheadBatchSize) CRApi.setPlayheadBatchSize(playheadBatchFrom(settings));
    // Fila e histórico não dependem um do outro: são lidos ao mesmo tempo, e as
    // páginas de cada um também (até o limite de consultas simultâneas).
    const [accountId, list, history] = await Promise.all([
      cacheScope(),
      CRApi.watchlist(settings.locale, { parallel: concurrencyFrom(settings), pageSize: playheadBatchFrom(settings) }),
      loadHistory(settings),
    ]);
    const items = list.map(normalizeItem).filter(Boolean);
    const unique = [...new Map(items.map((i) => [i.seriesId, i])).values()];
    const activity = historyActivity(history, settings);

    const cache = force ? {} : await loadCache(accountId);
    let done = 0;
    onProgress(done, unique.length);

    // Último play conhecido da série no histórico; undefined = não dá para saber
    // (histórico ausente, ou incompleto e a série não apareceu nele).
    const lastPlayedOf = (id) =>
      !history ? undefined : activity.has(id) ? activity.get(id) : history.complete ? 0 : undefined;

    const results = await pool(unique, concurrencyFrom(settings), async (entry) => {
      const sig = cacheSignature(modeFor(entry.seriesId, settings), settings);
      const hit = cache[entry.seriesId];
      const now = Date.now();
      const lastPlayed = lastPlayedOf(entry.seriesId);
      const reuse = (r) => ({ ...r, title: entry.title, image: r.image || entry.image });
      let result;
      let prefetched = null;

      const freshAt = hit ? Math.max(hit.checkedAt || 0, hit.revalidatedAt || 0) : 0;
      if (hit && hit.signature === sig && now - freshAt < CACHE_TTL) {
        result = reuse(hit);
      } else if (surelyNever(entry, history, activity)) {
        const mode = modeFor(entry.seriesId, settings);
        result = { ...entry, kind: entry.kind, mode, checkedAt: now, signature: sig, status: "never", pending: [], viaHistory: true };
      } else {
        // Revalidação barata: só as temporadas (1 consulta) + histórico (já baixado).
        const canRevalidate =
          hit &&
          entry.kind !== "movie" &&
          hit.signature === sig &&
          hit.fp &&
          now - hit.checkedAt < REVALIDATE_TTL &&
          lastPlayed !== undefined &&
          hit.fp.lastPlayed === lastPlayed &&
          !(hit.next && hit.next.at <= now);
        if (canRevalidate) {
          try {
            prefetched = await CRApi.seasons(entry.seriesId, settings.locale);
            if (seasonsKey(prefetched) === hit.fp.seasons) {
              cache[entry.seriesId] = { ...hit, revalidatedAt: now };
              result = reuse(cache[entry.seriesId]);
            }
          } catch (_) {
            prefetched = null; // segue para a análise completa
          }
        }
        if (!result) {
          result = await analyzeSafe(entry, settings, prefetched);
          if (result.status !== "error") {
            if (result.fp) result.fp.lastPlayed = lastPlayed;
            cache[entry.seriesId] = result;
          }
        }
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
      async movieListing(id, locale) {
        const r = await base.movieListing(id, locale);
        log.filmes[`titulo:${id}`] = r;
        return r;
      },
      async movies(id, locale) {
        const r = await base.movies(id, locale);
        log.filmes[id] = r;
        return r;
      },
    };
  }

  // Reanalisa uma série gravando tudo o que a análise usou. O arquivo não contém
  // token, cookie nem IDs de conta ou perfil: só catálogo e histórico da série.
  async function diagnose(entry, settings, { version = "", api = CRApi } = {}) {
    const mode = modeFor(entry.seriesId, settings);
    const log = { temporadas: {}, episodios: {}, filmes: {}, playheads: {} };
    let resultado;
    try {
      resultado = await analyzeEntry(entry, mode, settings, recordingApi(api, log));
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
        subLang: settings.subLang || "pt-BR",
        locale: settings.locale,
      },
      serie: entry,
      resultado,
      respostas: {
        temporadas: log.temporadas,
        episodios: log.episodios,
        filmes: log.filmes,
        playheads: Object.values(log.playheads),
      },
    });
  }

  // Reanalisa uma série só (ex.: depois de trocar o modo de áudio dela).
  async function runOne(entry, settings) {
    const accountId = await cacheScope();
    const result = await analyzeSafe(entry, settings);
    if (result.status !== "error") {
      const cache = await loadCache(accountId);
      cache[entry.seriesId] = result;
      await saveCache(accountId, cache);
    }
    return result;
  }

  return { run, runOne, cacheScope, historyActivity, diagnose, sanitize, extraKind, CONCURRENCY, concurrencyFrom, PLAYHEAD_BATCH, playheadBatchFrom, MIN_STARTED, MIN_STARTED_SECONDS, minStartedFrom };
})();
