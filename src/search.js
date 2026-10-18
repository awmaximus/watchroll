// Aba "Pesquisar": busca no catálogo da Crunchyroll (ou só na sua Fila) com filtros
// de dublagem, classificação indicativa, ano de estreia e temporada de lançamento.
//
// De onde vêm os candidatos (conferido na API real, out/2026):
//  - com texto: /discover/search (títulos em português e inglês) e, se ligado, o
//    AniList, que entende romaji e kanji e devolve o link da série na Crunchyroll;
//  - sem texto, com temporada: /discover/browse?seasonal_tag=… (filtro do servidor);
//  - sem texto, só a Fila: as séries da Fila, buscadas pelo ID;
//  - sem texto, nos demais casos: o catálogo INTEIRO (≈2.000 títulos, ~20 consultas em
//    paralelo, guardado por 6 h), filtrado aqui. Não dá para pedir só "as primeiras
//    páginas dos populares" e filtrar: o ranking de popularidade da Crunchyroll está
//    distorcido (Witch Hat Atelier, da primavera de 2026, vinha em 1.714º de 1.929) e
//    o filtro is_dubbed do servidor está desatualizado (a mesma série, dublada em
//    pt-BR, não está entre os 871 "dublados"). Conferido em out/2026.
// Dublagem, classificação e ano são conferidos aqui, com os dados de cada resultado.

/* global CRApi */
var CRSearch = (() => {
  const PAGE = 60;
  const ANILIST = "https://graphql.anilist.co";
  const SEASONS = ["winter", "spring", "summer", "fall"];

  // ---------- utilidades ----------
  function pickImage(images, wanted = 320) {
    const sets = (images && (images.poster_wide || images.poster_tall)) || [];
    const list = (sets[0] || []).slice().sort((a, b) => a.width - b.width);
    const hit = list.find((i) => i.width >= wanted) || list[list.length - 1];
    return hit ? hit.source : null;
  }

  // Classificação indicativa brasileira da Crunchyroll: "L", "A10", "A12", "A14",
  // "A16", "A18" (às vezes sem o "A": "16"). Devolve a idade mínima (L = 0).
  function ratingAge(meta) {
    const ext = meta && meta.extended_maturity_rating && meta.extended_maturity_rating.rating;
    const raw = [ext, ...((meta && meta.maturity_ratings) || [])].find((x) => x != null && x !== "");
    if (raw == null) return null;
    const s = String(raw).trim().toUpperCase();
    if (s === "L" || s === "AL" || s === "LIVRE") return 0;
    const m = /(\d{1,2})/.exec(s);
    return m ? Number(m[1]) : null;
  }

  function normalize(item, watchIds) {
    const meta = item.series_metadata || item.movie_listing_metadata || {};
    const type = item.type === "movie_listing" ? "movie" : "series";
    return {
      id: item.id,
      type,
      title: item.title || "",
      slug: item.slug_title || item.slug || "",
      image: pickImage(item.images),
      year: meta.series_launch_year || meta.movie_release_year || null,
      age: ratingAge(meta),
      audios: meta.audio_locales || [],
      subs: meta.subtitle_locales || [],
      episodes: meta.episode_count || null,
      seasons: meta.season_count || null,
      inWatchlist: !!(watchIds && watchIds.has(item.id)),
    };
  }

  const hasCJK = (q) => /[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(q || "");

  // IDs da Crunchyroll nos links do AniList: …/series/G3KHEVDJ7/… ou …/watch/…
  function crIdsFromLinks(links) {
    const ids = [];
    for (const l of links || []) {
      if (!/crunchyroll/i.test(l.site || "") && !/crunchyroll\.com/i.test(l.url || "")) continue;
      const m = /crunchyroll\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?series\/([A-Z0-9]+)/i.exec(l.url || "");
      if (m && !ids.includes(m[1].toUpperCase())) ids.push(m[1].toUpperCase());
    }
    return ids;
  }

  // ---------- AniList (romaji, kanji, inglês) ----------
  const ANILIST_QUERY =
    "query($s:String){Page(perPage:10){media(search:$s,type:ANIME){externalLinks{site url}}}}";

  async function anilistCrIds(q, fetchFn = fetch) {
    const res = await fetchFn(ANILIST, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { s: q } }),
      cache: "no-store",
      credentials: "omit",
    });
    if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
    const j = await res.json();
    const ids = [];
    for (const m of (j && j.data && j.data.Page && j.data.Page.media) || []) {
      for (const id of crIdsFromLinks(m.externalLinks)) if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  // ---------- filtros ----------
  // filters: { dub: "any"|"dub"|"nodub", maxAge: null|0|10|12|14|16|18,
  //            year: null|número, season: null|"fall-2026", scope: "all"|"mine" }
  function matches(r, filters, dubLang) {
    const f = filters || {};
    if (f.scope === "mine" && !r.inWatchlist) return false;
    if (f.dub === "dub" && !r.audios.includes(dubLang)) return false;
    if (f.dub === "nodub" && r.audios.includes(dubLang)) return false;
    if (f.maxAge != null && f.maxAge !== "" && (r.age == null || r.age > Number(f.maxAge))) return false;
    if (f.year && Number(r.year) !== Number(f.year)) return false;
    return true;
  }

  const seasonTagsOfYear = (year) => SEASONS.map((s) => `${s}-${year}`);

  // ---------- catálogo inteiro (guardado por 6 h) ----------
  const CATALOG_TTL = 6 * 60 * 60 * 1000;
  let catalogCache = null; // { locale, at, items }
  let catalogLoading = null;

  async function mapLimit(list, limit, fn) {
    const out = new Array(list.length);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
    return out;
  }

  function slim(x) {
    const meta = (m) =>
      m && {
        series_launch_year: m.series_launch_year,
        movie_release_year: m.movie_release_year,
        maturity_ratings: m.maturity_ratings,
        extended_maturity_rating: m.extended_maturity_rating && { rating: m.extended_maturity_rating.rating },
        audio_locales: m.audio_locales,
        subtitle_locales: m.subtitle_locales,
        episode_count: m.episode_count,
        season_count: m.season_count,
      };
    const img = (x.images && (x.images.poster_wide || x.images.poster_tall)) || null;
    return {
      id: x.id,
      type: x.type,
      title: x.title,
      slug_title: x.slug_title,
      images: img ? { poster_wide: [img[0] || []] } : undefined,
      series_metadata: meta(x.series_metadata),
      movie_listing_metadata: meta(x.movie_listing_metadata),
    };
  }

  async function catalog(locale, { api = CRApi, parallel = 4, force = false } = {}) {
    const now = Date.now();
    if (!force && catalogCache && catalogCache.locale === locale && now - catalogCache.at < CATALOG_TTL) {
      return catalogCache.items;
    }
    if (catalogLoading) return catalogLoading;
    catalogLoading = (async () => {
      const first = await api.browse({ sort_by: "popularity", n: 100, start: 0 }, locale);
      const total = first.total != null ? first.total : first.items.length;
      const starts = [];
      for (let st = 100; st < Math.min(total, 5000); st += 100) starts.push(st);
      const pages = await mapLimit(starts, parallel, (st) =>
        api.browse({ sort_by: "popularity", n: 100, start: st }, locale).then((r) => r.items)
      );
      // Guarda só o que a pesquisa usa: a resposta completa ocupa ~15 MB.
      const items = [...first.items, ...pages.flat()].map(slim);
      catalogCache = { locale, at: Date.now(), items };
      return items;
    })();
    try {
      return await catalogLoading;
    } finally {
      catalogLoading = null;
    }
  }

  // Ordem dos resultados: "default" (a da Crunchyroll/AniList), "year" (estreia
  // mais recente primeiro) ou "title" (A–Z).
  function sortItems(items, sort, uiLang) {
    if (sort === "year") {
      return items
        .map((r, i) => [r, i])
        .sort((a, b) => (b[0].year || 0) - (a[0].year || 0) || a[1] - b[1])
        .map(([r]) => r);
    }
    if (sort === "title") return items.slice().sort((a, b) => a.title.localeCompare(b.title, uiLang || undefined));
    return items;
  }

  async function browseAll(params, locale, api, limit = 1000) {
    const out = [];
    for (let start = 0; start < limit; start += 100) {
      const { items, total } = await api.browse({ ...params, n: 100, start }, locale);
      out.push(...items);
      if (!items.length || items.length < 100 || (total != null && out.length >= total)) break;
    }
    return out;
  }

  /**
   * Faz a pesquisa. Devolve { items, anilist }: todos os resultados, já filtrados e
   * ordenados (a página mostra de 60 em 60). anilist: "used" | "off" | "error" |
   * null (não se aplica).
   */
  async function run({ q = "", filters = {}, settings, watchIds = new Set(), useAniList = false, api = CRApi, fetchFn, uiLang, force = false }) {
    const locale = settings.locale;
    const dubLang = settings.dubLang;
    const text = q.trim();
    let raw = [];
    let anilist = null;

    if (text) {
      const tasks = [api.search(text, locale, { n: 50, preferredAudio: dubLang }).catch((e) => {
        if (!useAniList) throw e;
        return [];
      })];
      if (useAniList) {
        tasks.push(
          anilistCrIds(text, fetchFn)
            .then((ids) => ((anilist = "used"), ids))
            .catch(() => ((anilist = "error"), []))
        );
      } else {
        anilist = "off";
      }
      const [found, aniIds = []] = await Promise.all(tasks);
      const byId = new Map(found.map((x) => [x.id, x]));
      const missing = aniIds.filter((id) => !byId.has(id));
      for (const x of missing.length ? await api.objects(missing, locale) : []) byId.set(x.id, x);
      // O que o AniList achou vem primeiro, na ordem dele: ele acerta o título
      // (inclusive romaji/kanji), enquanto a busca da Crunchyroll devolve dezenas de
      // resultados aproximados. Depois, o resto da busca da Crunchyroll.
      const first = aniIds.map((id) => byId.get(id)).filter(Boolean);
      const firstIds = new Set(first.map((x) => x.id));
      raw = [...first, ...found.filter((x) => !firstIds.has(x.id))];
    } else if (filters.season) {
      raw = await browseAll({ seasonal_tag: filters.season, sort_by: "popularity" }, locale, api);
    } else if (filters.scope === "mine") {
      raw = watchIds.size ? await api.objects([...watchIds], locale) : [];
    } else {
      raw = await catalog(locale, { api, parallel: Number(settings.concurrency) || 4, force });
    }

    // Texto + temporada: a busca por texto não informa a temporada; cruza com a
    // lista da temporada (filtro do servidor).
    if (text && filters.season) {
      const inSeason = new Set(
        (await browseAll({ seasonal_tag: filters.season, sort_by: "popularity" }, locale, api)).map((x) => x.id)
      );
      raw = raw.filter((x) => inSeason.has(x.id));
    }

    const seen = new Set();
    const items = [];
    for (const it of raw) {
      if (!it || !it.id || seen.has(it.id)) continue;
      if (it.type && it.type !== "series" && it.type !== "movie_listing") continue;
      seen.add(it.id);
      const r = normalize(it, watchIds);
      if (matches(r, filters, dubLang)) items.push(r);
    }
    return { items: sortItems(items, filters.sort, uiLang), anilist };
  }

  // Temporadas para o filtro, com o nome traduzido pela própria Crunchyroll.
  async function seasons(locale, api = CRApi) {
    const list = await api.seasonList(locale);
    return list
      .filter((s) => s && s.id)
      .map((s) => ({ id: s.id, title: (s.localization && s.localization.title) || s.id }));
  }

  return {
    run,
    seasons,
    catalog,
    sortItems,
    normalize,
    ratingAge,
    matches,
    hasCJK,
    crIdsFromLinks,
    anilistCrIds,
    seasonTagsOfYear,
    ANILIST,
    PAGE,
  };
})();
