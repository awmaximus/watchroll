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
  const CACHE_KEY = "crnovos:v9:cache"; // v9: previsão do próximo episódio pelo ritmo semanal
  const CACHE_TTL = 5 * 60 * 1000; // dentro disso: reaproveita sem nenhuma consulta
  const REVALIDATE_TTL = 6 * 60 * 60 * 1000; // até isso: reaproveita se nada mudou
  // Quantas séries são consultadas ao mesmo tempo (configurável na página).
  const CONCURRENCY = { default: 4, min: 1, max: 32 };
  // Tamanho do lote (configurável na página): quantos IDs de episódio vão em cada
  // consulta de playheads e quantos itens vêm em cada página da Fila e do histórico.
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

  // IDs candidatos (em ordem) para a lista de episódios da temporada num áudio.
  // Em alguns títulos (filmes publicados como série, ex.: OVERLORD: O Reino Sagrado)
  // a Crunchyroll mistura em season.versions os IDs dos EPISÓDIOS com os das
  // temporadas, para o mesmo áudio; pedir episódios de um ID de episódio dá 400.
  // Por isso há vários candidatos, e quem chama tenta o próximo se um for recusado.
  function seasonCandidates(season, pick) {
    const out = [];
    const add = (id) => id && !out.includes(id) && out.push(id);
    if (pick === "original") {
      for (const v of season.versions || []) if (v.original) add(v.guid);
      if (!out.length) add(season.id);
    } else {
      if (season.audio_locale === pick) add(season.id);
      for (const v of season.versions || []) if (v.audio_locale === pick) add(v.guid);
      if ((season.audio_locales || []).includes(pick) && !(season.versions || []).length) add(season.id);
    }
    return out;
  }

  // Temporada de lançamento ("season" de anime) a partir de season_tags, que a
  // Crunchyroll manda traduzida ou em inglês, às vezes as duas: "Outono-2019",
  // "fall-2019", "Verão-2026"… Devolve { season: winter|spring|summer|fall, year }.
  const SEASON_NAMES = {
    winter: "winter", inverno: "winter", invierno: "winter", hiver: "winter",
    spring: "spring", primavera: "spring", printemps: "spring", fruhling: "spring", fruehling: "spring",
    summer: "summer", verao: "summer", verano: "summer", ete: "summer", sommer: "summer", estate: "summer",
    fall: "fall", autumn: "fall", outono: "fall", otono: "fall", automne: "fall", herbst: "fall", autunno: "fall",
  };
  function parseSeasonTag(tag) {
    const m = /^\s*([^\d-]+?)[\s_-]+(\d{4})\s*$/.exec(String(tag || ""));
    if (!m) return null;
    const name = m[1].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const season = SEASON_NAMES[name];
    return season ? { season, year: Number(m[2]) } : null;
  }

  // Temporada de lançamento da série: a da temporada mais recente que tiver etiqueta.
  function seriesLaunch(seasons) {
    for (let i = seasons.length - 1; i >= 0; i--) {
      for (const tag of seasons[i].season_tags || []) {
        const l = parseSeasonTag(tag);
        if (l) return l;
      }
    }
    return null;
  }

  // Tamanho da série, a partir da lista de temporadas (já sem as cópias por
  // dublagem): temporadas normais e a soma dos episódios delas. Uma série só com
  // temporadas especiais conta essas. null quando a API não traz os números.
  function seriesStats(seasons) {
    if (!seasons || !seasons.length) return null;
    const normal = seasons.filter((s) => !isSpecialSeason(s));
    const counted = normal.length ? normal : seasons;
    const known = counted.filter((s) => typeof s.number_of_episodes === "number");
    return {
      seasons: counted.length,
      episodes: known.length ? known.reduce((n, s) => n + Math.max(0, s.number_of_episodes), 0) : null,
    };
  }

  // Áudios que a temporada oferece (o dela, os das versões e audio_locales).
  function seasonAudios(season) {
    const set = new Set();
    if (season.audio_locale) set.add(season.audio_locale);
    for (const v of season.versions || []) if (v.audio_locale) set.add(v.audio_locale);
    for (const a of season.audio_locales || []) if (a) set.add(a);
    return [...set];
  }

  // Áudios da série: os da temporada mais recente e os de qualquer temporada.
  // Guardados no resultado para a página decidir o ícone com o idioma de dublagem
  // atual (trocar o idioma nas Configurações não exige consultar de novo).
  function seriesAudios(seasons) {
    if (!seasons.length) return null;
    const any = new Set();
    for (const s of seasons) for (const a of seasonAudios(s)) any.add(a);
    return { latest: seasonAudios(seasons[seasons.length - 1]), any: [...any] };
  }

  // Situação da dublagem no idioma escolhido, a partir dos áudios guardados:
  // "yes" (a temporada mais recente tem), "old" (só temporadas anteriores),
  // "no" (nenhuma) ou null (não se sabe: a série não foi consultada).
  function dubStatus(result, dubLang) {
    const a = result && result.audios;
    if (!a || !dubLang) return null;
    if ((a.latest || []).includes(dubLang)) return "yes";
    if ((a.any || []).includes(dubLang)) return "old";
    return "no";
  }

  // Episódios do primeiro candidato que a Crunchyroll aceitar. Recusas 400/404
  // ("not a valid season") passam para o próximo; outros erros sobem normalmente.
  async function episodesOfFirst(api, candidates, locale) {
    let lastErr = null;
    for (const id of candidates) {
      try {
        return { id, eps: await api.episodes(id, locale) };
      } catch (err) {
        if (err && (err.status === 400 || err.status === 404)) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    if (lastErr) console.warn("[Watchroll]", lastErr);
    return { id: candidates[0] || null, eps: [] };
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
  // ---------- categorias (gêneros) ----------
  // A Crunchyroll manda as categorias em "tenant_categories", já traduzidas, mas
  // nem sempre no idioma pedido (a mesma lista mistura "Fantasia" e "Fantasy").
  // Os nomes conhecidos viram uma chave fixa (traduzida pela extensão); os outros
  // ficam como vieram, com a chave "x:<nome>".
  const GENRES = {
    action: ["action", "acao", "accion", "aktion", "azione", "aksi", "boevik", "экшен", "боевик"],
    adventure: ["adventure", "aventura", "aventure", "abenteuer", "avventura", "petualangan", "приключения"],
    comedy: ["comedy", "comedia", "comedie", "komodie", "commedia", "komedi", "комедия"],
    drama: ["drama", "drame", "драма"],
    fantasy: ["fantasy", "fantasia", "fantastique", "fantasi", "фэнтези"],
    music: ["music", "musica", "musique", "musik", "musikal", "музыка"],
    romance: ["romance", "romantik", "romantico", "romantique", "romantisch", "романтика"],
    scifi: ["scifi", "sciencefiction", "ficcaocientifica", "cienciaficcion", "fantascienza", "fiksiilmiah", "научнаяфантастика"],
    seinen: ["seinen", "сэйнэн"],
    shojo: ["shojo", "shoujo", "сёдзё"],
    shonen: ["shonen", "shounen", "сёнэн"],
    sliceoflife: ["sliceoflife", "cotidiano", "recuentosdelavida", "tranchedevie", "повседневность"],
    sports: ["sports", "sport", "esportes", "deportes", "olahraga", "спорт"],
    supernatural: ["supernatural", "sobrenatural", "surnaturel", "ubernaturlich", "soprannaturale", "supranatural", "сверхъестественное"],
    thriller: ["thriller", "suspense", "suspenso", "триллер"],
    mystery: ["mystery", "misterio", "mystere", "mysterium", "mistero", "misteri", "детектив", "мистика"],
    horror: ["horror", "terror", "horreur", "ужасы"],
  };
  const GENRE_KEYS = Object.keys(GENRES);
  const genreFold = (label) =>
    String(label || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  const GENRE_BY_NAME = new Map();
  for (const [key, names] of Object.entries(GENRES)) for (const n of names) GENRE_BY_NAME.set(genreFold(n), key);
  function genreKey(label) {
    const f = genreFold(label);
    if (!f) return null;
    return GENRE_BY_NAME.get(f) || `x:${String(label).trim()}`;
  }
  // Lista sem repetição, na ordem em que vieram.
  function genreKeys(labels) {
    const out = [];
    for (const l of Array.isArray(labels) ? labels : []) {
      const k = genreKey(l);
      if (k && !out.includes(k)) out.push(k);
    }
    return out;
  }
  const itemGenres = (p) =>
    genreKeys(
      ((p.series_metadata || p.movie_listing_metadata || p.episode_metadata || p.movie_metadata || {}).tenant_categories) ||
        p.tenant_categories
    );

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
        rating: itemRating(p),
        genres: itemGenres(p),
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
      rating: itemRating(p),
      genres: itemGenres(p),
    };
  }

  // Nota da Crunchyroll que vem no item (listas pedidas com ratings=true).
  function itemRating(p) {
    const r = p && p.rating;
    const average = parseFloat(r && r.average);
    const total = Number(r && r.total) || 0;
    return Number.isFinite(average) && total > 0 ? { average, total } : null;
  }

  // ---------- análise de uma série ----------
  // Impressão digital das temporadas: muda quando entra temporada, episódio ou versão.
  // Impressão digital de uma lista de episódios: muda quando um episódio é
  // liberado (inclusive um que já estava listado com data futura), quando ganha
  // uma versão de áudio nova (dublagem) ou uma legenda nova.
  const episodesKey = (list, now) =>
    (list || [])
      .filter((e) => !e.is_clip)
      .map(
        (e) =>
          `${e.id}:${isAvailable(e, now) ? 1 : 0}:${(e.versions || []).length}:${(e.subtitle_locales || []).length}`
      )
      .join(",");

  const seasonsKey = (list) =>
    sortSeasons(list || [])
      .map((x) => `${x.id}:${x.number_of_episodes ?? ""}:${(x.versions || []).length}`)
      .join("|");

  async function analyzeSeries(entry, mode, settings, api = CRApi, prefetchedSeasons = null) {
    const now = Date.now();
    const { locale, dubLang } = settings;
    const subLang = settings.subLang || "pt-BR";
    const minStarted = minStartedFrom(settings);
    const rawSeasons = prefetchedSeasons || (await api.seasons(entry.seriesId, locale, settings.dubLang));
    const seasons = sortSeasons(rawSeasons);

    const ordered = [];
    let anyActivity = false;
    let dubMissingSomewhere = false;
    let waitingDubLatest = 0;
    // Modo dublado: a temporada mais recente tem algum episódio no idioma escolhido?
    // null = ainda não examinada. false = não tem nenhum ("sem dublagem", não
    // "aguardando": a dublagem pode nunca sair).
    let latestHasDub = null;
    // Listas de episódios usadas na temporada mais recente e a impressão digital
    // de cada uma, para a revalidação perceber episódio/dublagem/legenda nova.
    let latestFp = null;
    // Episódios da temporada mais recente, para prever o próximo pelo ritmo semanal.
    let latest = null;

    for (let i = seasons.length - 1, back = 0; i >= 0 && back < MAX_SEASONS_BACK; i--, back++) {
      const season = seasons[i];

      // Qual lista de episódios usar para esta temporada, conforme o modo.
      let listId = season.id;
      let eligible = true;
      let candidates = [listId];
      if (mode === "sub") {
        candidates = seasonCandidates(season, "original");
      } else if (mode === "dub") {
        const dubIds = seasonCandidates(season, dubLang);
        if (dubIds.length) candidates = dubIds;
        else {
          eligible = false; // sem dublagem: serve só para saber o que você já viu
          dubMissingSomewhere = true;
        }
      }

      let got = await episodesOfFirst(api, candidates, locale);
      listId = got.id || listId;
      let eps = got.eps;
      let usedList = listId;
      if (!eps.length && listId !== season.id) {
        eps = await api.episodes(season.id, locale);
        usedList = season.id;
        if (mode === "dub") {
          eligible = false;
          dubMissingSomewhere = true;
        }
      }
      if (back === 0) latestFp = { lists: [usedList], parts: [episodesKey(eps, now)] };
      eps = eps
        .filter((e) => !e.is_clip)
        .sort((a, b) => (a.sequence_number ?? 0) - (b.sequence_number ?? 0));
      if (!eps.length) continue;
      if (back === 0) latest = { eps, season, eligible };

      if (mode === "dub" && latestHasDub === null) {
        latestHasDub = eligible && eps.some((e) => isInAudio(e, dubLang));
      }

      const ids = [];
      for (const ep of eps) ids.push(...versionIds(ep));
      // Modo dublado, temporada mais recente: episódios que já saíram no áudio
      // original mas ainda não têm dublagem lançada ("aguardando dublagem").
      let origOnly = [];
      if (mode === "dub" && eligible && back === 0) {
        const origCands = seasonCandidates(season, "original");
        if (!origCands.includes(listId)) {
          const origIds = origCands;
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
          const orig = await episodesOfFirst(api, origIds, locale);
          if (latestFp && orig.id) {
            latestFp.lists.push(orig.id);
            latestFp.parts.push(episodesKey(orig.eps, now));
          }
          origOnly = orig.eps.filter(
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
      fp: { seasons: seasonsKey(rawSeasons), latest: latestFp },
      audios: seriesAudios(seasons),
      launch: seriesLaunch(seasons),
      stats: seriesStats(seasons),
    };
    const upcoming = () =>
      nextRelease(ordered, mode, dubLang, now) ||
      (latest && latest.eligible ? estimateNext(latest.eps, latest.season, mode, dubLang, now) : null);
    if (!anyActivity) return { ...base, status: "never", pending: [], next: upcoming() };

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
      next: upcoming(),
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
      audios: (() => {
        const a = [...new Set(lists.filter((l) => l.items.length && l.audio).map((l) => l.audio))];
        return a.length ? { latest: a, any: a } : null;
      })(),
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

  // A Crunchyroll só põe o episódio no catálogo quando ele sai, então quase nunca
  // há data futura. Para simulcasts, a previsão segue o ritmo: se os últimos
  // episódios saíram de semana em semana, o próximo sai 7 dias depois do último,
  // no mesmo horário. Sem ritmo semanal, ou com o episódio previsto já atrasado
  // (pausa ou fim da temporada), não há previsão.
  const DAY_MS = 86400000;
  const WEEK_MS = 7 * DAY_MS;
  function estimateNext(eps, season, mode, dubLang, now) {
    const out = (eps || [])
      .filter((e) => isAvailable(e, now) && !extraKind(e, season) && (mode !== "dub" || isInAudio(e, dubLang)))
      .map((e) => ({ e, at: Date.parse(e.availability_starts || e.premium_available_date || "") }))
      .filter((x) => x.at && x.at <= now)
      .sort((a, b) => a.at - b.at);
    if (out.length < 2) return null;
    const gaps = [];
    for (let i = Math.max(1, out.length - 4); i < out.length; i++) gaps.push(out[i].at - out[i - 1].at);
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    if (median < 6 * DAY_MS || median > 8 * DAY_MS) return null;
    const last = out[out.length - 1];
    const at = last.at + WEEK_MS;
    if (at <= now) return null;
    const n = parseInt(last.e.episode != null && last.e.episode !== "" ? last.e.episode : last.e.episode_number, 10);
    const number = Number.isFinite(n) ? String(n + 1) : "";
    return {
      at,
      id: `est:${season.id}:${number || at}`,
      season: last.e.season_number,
      number,
      title: "",
      estimated: true,
    };
  }

  // Série ainda não começada (pelo histórico, sem ler os episódios): se a temporada
  // mais recente é desta temporada de anime ou da anterior, lê os episódios dela
  // (1 consulta) só para prever o próximo lançamento.
  const RECENT_LAUNCH_MS = 200 * DAY_MS;
  const SEASON_MONTH = { winter: 0, spring: 3, summer: 6, fall: 9 };
  async function nextForNever(seasons, mode, settings, api = CRApi, now = Date.now()) {
    const launch = seriesLaunch(seasons);
    if (!launch) return null;
    const start = Date.UTC(launch.year, SEASON_MONTH[launch.season] || 0, 1);
    if (now - start > RECENT_LAUNCH_MS || start - now > 31 * DAY_MS) return null;
    const normal = seasons.filter((x) => !isSpecialSeason(x));
    const season = (normal.length ? normal : seasons)[(normal.length ? normal : seasons).length - 1];
    if (!season) return null;
    let candidates = [season.id];
    if (mode === "sub") candidates = seasonCandidates(season, "original");
    else if (mode === "dub") {
      candidates = seasonCandidates(season, settings.dubLang);
      if (!candidates.length) return null;
    }
    const got = await episodesOfFirst(api, candidates, settings.locale);
    return estimateNext(got.eps || [], season, mode, settings.dubLang, now);
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
      console.warn("[Watchroll]", entry.title, err);
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
      return await CRApi.watchHistory(settings.locale, {
        parallel: concurrencyFrom(settings),
        pageSize: playheadBatchFrom(settings),
      });
    } catch (err) {
      console.warn("[Watchroll] histórico indisponível, seguindo sem ele:", err);
      return null;
    }
  }

  // Atalho seguro para "nunca assistida": o histórico foi lido até o fim, a série
  // não aparece nele com atividade E a própria Crunchyroll diz never_watched.
  const surelyNever = (entry, history, activity) =>
    !!(history && history.complete && entry.neverWatchedFlag && !activity.has(entry.seriesId));

  // Confere as listas de episódios da temporada mais recente (1 consulta, ou 2 no
  // modo dublado). Sem impressão digital guardada (série sem episódios), não há o
  // que conferir: as temporadas iguais bastam.
  async function sameLatestEpisodes(latest, settings, now) {
    if (!latest || !latest.lists || !latest.lists.length) return true;
    const parts = await Promise.all(
      latest.lists.map((id) => CRApi.episodes(id, settings.locale).then((eps) => episodesKey(eps, now)))
    );
    return parts.every((p, i) => p === latest.parts[i]);
  }

  // ---------- listas de origem ----------
  // "watchlist" = a Fila; os demais valores são IDs de Crunchylists. Sem nenhuma
  // escolhida, vale a Fila (é o que a extensão sempre leu).
  const WATCHLIST = "watchlist";
  function listSources(settings) {
    const raw = Array.isArray(settings && settings.sources) ? settings.sources : [];
    const out = [...new Set(raw.filter((x) => typeof x === "string" && x))];
    return out.length ? out : [WATCHLIST];
  }

  // Lê a Fila e as Crunchylists escolhidas ao mesmo tempo. Uma lista que não
  // existe mais (apagada no site: HTTP 404) é ignorada; outros erros param tudo,
  // como já acontecia com a Fila.
  async function readSources(settings, api = CRApi) {
    const parallel = concurrencyFrom(settings);
    return Promise.all(
      listSources(settings).map(async (id) => {
        if (id === WATCHLIST) {
          return { id, items: await api.watchlist(settings.locale, { parallel, pageSize: playheadBatchFrom(settings) }) };
        }
        try {
          return { id, items: await api.customListItems(id, settings.locale) };
        } catch (err) {
          if (err && err.status === 404) return { id, items: [], missing: true };
          throw err;
        }
      })
    );
  }

  // Junta as listas numa série por vez, guardando em `lists` de onde cada uma
  // veio (na ordem das listas escolhidas). A marca "nunca assistida" só existe
  // na Fila: basta uma lista dizer isso.
  function mergeSources(sourced) {
    const map = new Map();
    for (const { id, items } of sourced) {
      for (const item of items || []) {
        const e = normalizeItem(item);
        if (!e) continue;
        const prev = map.get(e.seriesId);
        if (!prev) map.set(e.seriesId, { ...e, lists: [id] });
        else {
          if (!prev.lists.includes(id)) prev.lists.push(id);
          prev.neverWatchedFlag = prev.neverWatchedFlag || e.neverWatchedFlag;
          if (!prev.image) prev.image = e.image;
          if (!prev.rating) prev.rating = e.rating;
          for (const g of e.genres || []) if (!prev.genres.includes(g)) prev.genres.push(g);
        }
      }
    }
    return [...map.values()];
  }

  // "auto" no idioma dos títulos vira o idioma da interface (ou inglês) antes de
  // qualquer consulta: todas as chamadas à API recebem o mesmo locale.
  const withLocale = (settings) =>
    typeof CRI18n !== "undefined" && CRI18n.contentLocale
      ? { ...settings, locale: CRI18n.contentLocale(settings.locale, settings.uiLang) }
      : { ...settings, locale: settings.locale && settings.locale !== "auto" ? settings.locale : "en-US" };

  async function run({ settings, force = false, onProgress = () => {} }) {
    settings = withLocale(settings);
    if (CRApi.setPlayheadBatchSize) CRApi.setPlayheadBatchSize(playheadBatchFrom(settings));
    // Fila e histórico não dependem um do outro: são lidos ao mesmo tempo, e as
    // páginas de cada um também (até o limite de consultas simultâneas).
    const [accountId, sourced, history] = await Promise.all([
      cacheScope(),
      readSources(settings),
      loadHistory(settings),
    ]);
    const unique = mergeSources(sourced);
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
        // Uma consulta só (temporadas), para o ícone de dublagem e a temporada de
        // lançamento da aba "Ainda não começadas". Se falhar, segue sem elas.
        if (entry.kind !== "movie") {
          try {
            const ss = sortSeasons(await CRApi.seasons(entry.seriesId, settings.locale, settings.dubLang));
            result.audios = seriesAudios(ss);
            result.launch = seriesLaunch(ss);
            result.stats = seriesStats(ss);
            result.next = await nextForNever(ss, mode, settings, CRApi, now);
          } catch (_) {}
        }
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
            prefetched = await CRApi.seasons(entry.seriesId, settings.locale, settings.dubLang);
            if (seasonsKey(prefetched) === hit.fp.seasons && (await sameLatestEpisodes(hit.fp.latest, settings, now))) {
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
      // De quais listas a série veio (não vai para o cache: muda sem mudar a série).
      return {
        ...result,
        lists: entry.lists,
        rating: entry.rating || result.rating || null,
        genres: entry.genres && entry.genres.length ? entry.genres : result.genres || [],
      };
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
      async seasons(id, locale, preferredAudio) {
        const r = await base.seasons(id, locale, preferredAudio);
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
    settings = withLocale(settings);
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
    settings = withLocale(settings);
    const accountId = await cacheScope();
    const result = await analyzeSafe(entry, settings);
    if (result.status !== "error") {
      const cache = await loadCache(accountId);
      cache[entry.seriesId] = result;
      await saveCache(accountId, cache);
    }
    return entry.lists ? { ...result, lists: entry.lists } : result;
  }

  return { run, runOne, cacheScope, withLocale, WATCHLIST, listSources, readSources, mergeSources, historyActivity, dubStatus, seriesAudios, parseSeasonTag, seriesLaunch, seriesStats, estimateNext, genreKey, genreKeys, GENRE_KEYS, nextForNever, diagnose, sanitize, extraKind, CONCURRENCY, concurrencyFrom, PLAYHEAD_BATCH, playheadBatchFrom, MIN_STARTED, MIN_STARTED_SECONDS, minStartedFrom };
})();
