// Notas de outros sites: AniList (nota média, 0–100) e MyAnimeList (0–10).
//
// Manda os nomes das séries (o slug da Crunchyroll) ao AniList e os IDs do
// MyAnimeList ao Jikan (serviço público que entrega os dados do MyAnimeList).
// Sem servidor próprio: as consultas saem direto do navegador.
//
//  - AniList: GraphQL, várias séries por consulta (apelidos a0, a1…). A busca usa o
//    slug da Crunchyroll (sempre em inglês, ex.: "the-apothecary-diaries"); a série
//    certa é a que tem o link da Crunchyroll com o mesmo ID; sem link, só vale o
//    título igual. Sem resultado, tenta de novo com as primeiras palavras (o
//    AniList não acha títulos longos com a pontuação tirada, ex.: "ill" de "I'll").
//    Conferido em nov/2026: limite de 30 consultas por minuto.
//  - MyAnimeList: o AniList dá o ID (idMal); a nota vem do Jikan
//    (api.jikan.moe/v4/anime/{id}), no máximo ~1 consulta por segundo.
//  - Tudo fica guardado por 7 dias (falhas: tenta de novo em 1 dia), por série.

/* global browser */
var CRScores = (() => {
  const ANILIST = "https://graphql.anilist.co";
  const JIKAN = "https://api.jikan.moe/v4/anime/";
  const KEY = "crnovos:scores";
  const DAY = 86400000;
  const TTL = 7 * DAY;
  const RETRY = DAY;
  const BATCH = 10; // séries por consulta ao AniList
  const JIKAN_GAP = 1100; // ms entre consultas ao Jikan

  let sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const simplify = (s) =>
    String(s || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/['’`]/g, "") // "Journey's" = "journeys" (como no slug)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  // Texto da busca: o slug (inglês) ou, sem ele, o título.
  const queryText = (s) => simplify(s.slug ? s.slug.replace(/-/g, " ") : s.title);
  // Buscas mais curtas, para quando o título inteiro não acha nada.
  const shorter = (q) => {
    const w = q.split(" ");
    return [w.slice(0, 4), w.slice(0, 3), w.slice(0, 2)].map((x) => x.join(" ")).filter((x, i, a) => x !== q && a.indexOf(x) === i);
  };

  const crIdOf = (url) => {
    const m = /crunchyroll\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?series\/([A-Z0-9]+)/i.exec(url || "");
    return m ? m[1].toUpperCase() : null;
  };

  // A série da Crunchyroll junta todas as temporadas; no AniList cada uma é um anime.
  // Vale a primeira temporada de TV (estreia mais antiga), não um filme ou especial.
  const FORMAT_RANK = { TV: 0, TV_SHORT: 0, ONA: 1, OVA: 2, SPECIAL: 3, MOVIE: 4 };
  const firstSeason = (list) =>
    list
      .slice()
      .sort(
        (a, b) =>
          (FORMAT_RANK[a.format] ?? 5) - (FORMAT_RANK[b.format] ?? 5) ||
          ((a.startDate && a.startDate.year) || 9999) - ((b.startDate && b.startDate.year) || 9999) ||
          a.id - b.id
      )[0];

  /**
   * Entre os resultados do AniList, o anime desta série (ou null): os que têm o link
   * da Crunchyroll com o mesmo ID e os de título igual (a 1ª temporada às vezes não
   * tem o link); entre eles, a primeira temporada. Sem nenhum dos dois, nada (melhor
   * sem nota do que com a nota de outro anime).
   */
  function pick(media, s) {
    const id = String(s.id || "").toUpperCase();
    const want = new Set([simplify(s.title), queryText(s)].filter(Boolean));
    const linked = (m) => (m.externalLinks || []).some((l) => crIdOf(l.url) === id);
    const sameTitle = (m) => {
      const t = m.title || {};
      return [t.english, t.romaji].some((x) => x && want.has(simplify(x)));
    };
    const ok = media.filter((m) => linked(m) || sameTitle(m));
    return ok.length ? firstSeason(ok) : null;
  }

  const MEDIA_FIELDS = "id idMal averageScore format startDate{year} title{romaji english} externalLinks{url}";
  const TIMEOUT = 15000;

  // fetch com tempo-limite: um serviço que não responde não pode travar a fila.
  async function fetchWithTimeout(fetchFn, url, init = {}) {
    if (typeof AbortController === "undefined") return fetchFn(url, init);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      return await fetchFn(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Uma consulta ao AniList com várias buscas. Devolve a lista de resultados de cada uma. */
  async function anilistSearch(queries, fetchFn) {
    const vars = {};
    const parts = queries.map((q, i) => {
      vars["s" + i] = q;
      return `a${i}:Page(perPage:10){media(search:$s${i},type:ANIME){${MEDIA_FIELDS}}}`;
    });
    const decl = queries.map((_, i) => `$s${i}:String`).join(",");
    const res = await fetchWithTimeout(fetchFn, ANILIST, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: `query(${decl}){${parts.join(" ")}}`, variables: vars }),
      cache: "no-store",
      credentials: "omit",
    });
    if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
    const j = await res.json();
    const data = (j && j.data) || {};
    return queries.map((_, i) => (data["a" + i] && data["a" + i].media) || []);
  }

  /** AniList para várias séries: Map id → { id, score, idMal } | null. */
  async function anilistFor(series, fetchFn) {
    const out = new Map();
    const run = async (list, makeQuery) => {
      for (let i = 0; i < list.length; i += BATCH) {
        const chunk = list.slice(i, i + BATCH);
        const results = await anilistSearch(chunk.map(makeQuery), fetchFn);
        chunk.forEach((s, k) => {
          const m = pick(results[k], s);
          if (m) out.set(s.id, { id: m.id, score: m.averageScore == null ? null : m.averageScore, idMal: m.idMal || null });
        });
      }
    };
    await run(series, queryText);
    for (let level = 0; level < 3; level++) {
      const missing = series.filter((s) => !out.has(s.id) && shorter(queryText(s))[level]);
      if (!missing.length) break;
      await run(missing, (s) => shorter(queryText(s))[level]);
    }
    for (const s of series) if (!out.has(s.id)) out.set(s.id, null);
    return out;
  }

  /** Nota do MyAnimeList pelo Jikan: { score, users } (score null = sem nota). */
  async function malScore(idMal, fetchFn) {
    const res = await fetchWithTimeout(fetchFn, JIKAN + encodeURIComponent(idMal), { cache: "no-store", credentials: "omit" });
    if (res.status === 404) return { score: null, users: 0 };
    if (!res.ok) throw new Error(`Jikan HTTP ${res.status}`);
    const d = ((await res.json()) || {}).data || {};
    return { score: typeof d.score === "number" ? d.score : null, users: Number(d.scored_by) || 0 };
  }

  async function load(b = browser) {
    try {
      return (await b.storage.local.get(KEY))[KEY] || {};
    } catch (_) {
      return {};
    }
  }
  async function save(all, b = browser) {
    try {
      await b.storage.local.set({ [KEY]: all });
    } catch (_) {}
  }

  const fresh = (part, now) => part && now - (part.at || 0) < (part.failed || part.none ? RETRY : TTL);

  /**
   * Atualiza as notas das séries (lista de { id, title, slug }) que faltam ou estão
   * velhas. onUpdate(all) é chamado a cada parte nova (a página redesenha).
   * Devolve o mapa guardado: id → { al: {...}, mal: {...} }.
   */
  // Uma atualização por vez (as seguintes esperam e reaproveitam o que já veio).
  let chain = Promise.resolve();
  function update(series, opts = {}) {
    const job = chain.then(() => doUpdate(series, opts));
    chain = job.catch(() => {});
    return job;
  }

  async function doUpdate(series, { fetchFn = fetch, b = browser, onUpdate = () => {}, now = Date.now() } = {}) {
    const all = await load(b);
    const list = (series || []).filter((s) => s && s.id && (s.slug || s.title));
    const seen = new Set();
    const unique = list.filter((s) => !seen.has(s.id) && seen.add(s.id));

    // 1. AniList
    const needAl = unique.filter((s) => !fresh(all[s.id] && all[s.id].al, now));
    if (needAl.length) {
      try {
        const found = await anilistFor(needAl, fetchFn);
        for (const s of needAl) {
          const r = found.get(s.id);
          const prev = all[s.id] || {};
          all[s.id] = { ...prev, al: r ? { ...r, at: now } : { none: true, at: now } };
        }
      } catch (err) {
        console.warn("[Watchroll] AniList:", err);
        for (const s of needAl) {
          const prev = all[s.id] || {};
          if (!prev.al || !prev.al.id) all[s.id] = { ...prev, al: { failed: true, at: now } };
        }
      }
      await save(all, b);
      onUpdate(all);
    }

    // 2. MyAnimeList (pelo ID que o AniList deu), um por vez
    const needMal = unique.filter((s) => {
      const e = all[s.id];
      return e && e.al && e.al.idMal && !fresh(e.mal && e.mal.id === e.al.idMal ? e.mal : null, now);
    });
    let changed = 0;
    let failures = 0; // 2 falhas seguidas: o Jikan está fora; tenta de novo outro dia
    for (let i = 0; i < needMal.length; i++) {
      const s = needMal[i];
      const idMal = all[s.id].al.idMal;
      if (failures >= 2) {
        all[s.id].mal = { id: idMal, failed: true, at: Date.now() };
        continue;
      }
      try {
        const r = await malScore(idMal, fetchFn);
        all[s.id].mal = { id: idMal, score: r.score, users: r.users, at: Date.now() };
        failures = 0;
      } catch (err) {
        all[s.id].mal = { id: idMal, failed: true, at: Date.now() };
        if (!failures) console.warn("[Watchroll] MyAnimeList (Jikan):", err);
        failures++;
      }
      changed++;
      if (changed % 5 === 0) {
        await save(all, b);
        onUpdate(all);
      }
      if (i < needMal.length - 1) await sleep(JIKAN_GAP);
    }
    if (needMal.length) {
      await save(all, b);
      onUpdate(all);
    }

    // Entradas sem uso há 60 dias saem.
    for (const [id, e] of Object.entries(all)) {
      const last = Math.max((e.al && e.al.at) || 0, (e.mal && e.mal.at) || 0);
      if (now - last > 60 * DAY) delete all[id];
    }
    return all;
  }

  /** Notas guardadas de uma série: { al: número|null, alId, mal: número|null, malId }. */
  function scoresOf(all, id) {
    const e = (all || {})[id] || {};
    const al = e.al && typeof e.al.score === "number" ? e.al.score : null;
    const mal = e.mal && typeof e.mal.score === "number" ? e.mal.score : null;
    return { al, alId: (e.al && e.al.id) || null, mal, malId: (e.mal && e.mal.id) || (e.al && e.al.idMal) || null, malUsers: (e.mal && e.mal.users) || 0 };
  }

  return {
    KEY,
    load,
    update,
    scoresOf,
    pick,
    queryText,
    anilistFor,
    malScore,
    simplify,
    setSleep: (fn) => (sleep = fn),
  };
})();
