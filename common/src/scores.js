// Notas de outros sites: AniList (nota média, 0–100) e MyAnimeList (0–10).
//
// Manda os nomes das séries (o slug da Crunchyroll) ao AniList e os IDs do
// MyAnimeList à API oficial do MyAnimeList.
// Sem servidor próprio: as consultas saem direto do navegador.
//
//  - AniList: GraphQL, várias séries por consulta (apelidos a0, a1…). A busca usa o
//    slug da Crunchyroll (sempre em inglês, ex.: "the-apothecary-diaries"); a série
//    certa é a que tem o link da Crunchyroll com o mesmo ID; sem link, só vale o
//    título igual. Sem resultado, tenta de novo com as primeiras palavras (o
//    AniList não acha títulos longos com a pontuação tirada, ex.: "ill" de "I'll").
//    Até 35 séries por consulta (limite de complexidade do AniList). Conferido em
//    nov/2026: 90 consultas por minuto, 30 quando o AniList está sobrecarregado.
//  - MyAnimeList: o AniList dá o ID (idMal); a nota vem da API oficial
//    (api.myanimelist.net/v2/anime/{id}, com o Client ID de mal-client.js; sem CORS,
//    por isso a extensão tem permissão para esse endereço). Sem Client ID, não há
//    nota do MyAnimeList.
//  - Tudo fica guardado por série por 4, 8, 12 ou 24 horas (Configurações). Falhas:
//    AniList tenta de novo em 1 dia, MyAnimeList em 1 hora (no máximo o mesmo prazo).

/* global browser, MAL_CLIENT_ID */
var CRScores = (() => {
  const ANILIST = "https://graphql.anilist.co";
  const MAL_API = "https://api.myanimelist.net/v2/anime/";
  const MAL_ORIGIN = "https://api.myanimelist.net/*";
  const KEY = "crnovos:scores";
  const DAY = 86400000;
  // Quanto tempo as notas ficam guardadas: 4, 8, 12 ou 24 horas (Configurações).
  const TTL_HOURS = [4, 8, 12, 24];
  const DEFAULT_TTL_HOURS = 24;
  const ttlHoursFrom = (settings) => {
    const h = Number(settings && settings.scoresTtlHours);
    return TTL_HOURS.includes(h) ? h : DEFAULT_TTL_HOURS;
  };
  const RETRY = DAY;
  const MAL_RETRY = 3600000; // falha no MyAnimeList: tenta de novo em 1 hora
  // Séries por consulta ao AniList (cada uma vira um apelido a0, a1… na mesma consulta).
  // O AniList limita a "complexidade" da consulta a 500, e cada série com estes campos
  // custa 13 (conferido em nov/2026: 38 passam, 39 dão "Max query complexity"). 35 deixa
  // folga; se mesmo assim passar do limite, a consulta é dividida ao meio.
  const BATCH = 35;
  const MAL_GAP = 400; // ms entre consultas de cada trabalhador à API oficial do MyAnimeList
  const MAL_PARALLEL = 3; // consultas ao mesmo tempo à API oficial
  const MAL_429_TRIES = 3; // "pedidos demais" seguidos na mesma série: desiste dela por ora

  let clientId = typeof MAL_CLIENT_ID === "string" ? MAL_CLIENT_ID.trim() : "";
  // Fonte gravada em cada nota: falhas de outra fonte (o Jikan, que saiu, ou a gravada
  // como "mal" antes do aviso de permissão) não esperam o prazo para tentar de novo.
  const malSource = () => "mal-api";
  /** Há como buscar as notas do MyAnimeList (Client ID configurado)? */
  const malActive = () => !!clientId;

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
    const body = JSON.stringify({ query: `query(${decl}){${parts.join(" ")}}`, variables: vars });
    let res;
    // Limite do AniList (30 consultas/min em nov/2026): no 429, espera o Retry-After.
    for (let attempt = 0; ; attempt++) {
      res = await fetchWithTimeout(fetchFn, ANILIST, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
        cache: "no-store",
        credentials: "omit",
      });
      if (res.status !== 429 || attempt >= 3) break;
      const wait = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
      await sleep(Math.min(90, Number.isFinite(wait) && wait > 0 ? wait : 60) * 1000);
    }
    if (res.status === 400 && queries.length > 1) {
      const j = await res.json().catch(() => null);
      const msg = ((j && j.errors) || []).map((e) => e && e.message).join(" ");
      if (/complexity/i.test(msg)) {
        const half = Math.ceil(queries.length / 2);
        const a = await anilistSearch(queries.slice(0, half), fetchFn);
        const b = await anilistSearch(queries.slice(half), fetchFn);
        return a.concat(b);
      }
      throw new Error(`AniList HTTP ${res.status}`);
    }
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

  // "Pedidos demais" (HTTP 429): erro com o tempo de espera, para quem chamou recuar.
  function tooMany(res, name) {
    const err = new Error(`${name} HTTP 429`);
    err.status = 429;
    const wait = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
    err.retryAfter = Math.min(60, Number.isFinite(wait) && wait > 0 ? wait : 5) * 1000;
    return err;
  }

  /** Nota do MyAnimeList: { score, users } (score null = sem nota). */
  async function malScore(idMal, fetchFn) {
    if (!clientId) throw new Error("MyAnimeList: sem Client ID (common/src/mal-client.js)");
    const id = encodeURIComponent(idMal);
    const res = await fetchWithTimeout(fetchFn, `${MAL_API}${id}?fields=mean,num_scoring_users`, {
      headers: { "X-MAL-CLIENT-ID": clientId, Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
    });
    if (res.status === 404) return { score: null, users: 0 };
    if (res.status === 429) throw tooMany(res, "MyAnimeList");
    if (!res.ok) throw new Error(`MyAnimeList HTTP ${res.status}`);
    const d = (await res.json()) || {};
    return { score: typeof d.mean === "number" ? d.mean : null, users: Number(d.num_scoring_users) || 0 };
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

  // Falha (ou série não achada) tenta de novo antes: no máximo no mesmo prazo das notas.
  const fresh = (part, now, ttl, retry = RETRY) => part && now - (part.at || 0) < (part.failed || part.none ? Math.min(retry, ttl) : ttl);

  /**
   * A API oficial do MyAnimeList não tem CORS: só funciona com a permissão para
   * api.myanimelist.net. No Firefox o usuário pode tê-la desligada (ou ela não foi
   * dada na atualização). Sem Client ID não há o que pedir (devolve true).
   */
  async function malAllowed(b = browser) {
    if (!clientId) return true;
    try {
      if (!b.permissions || !b.permissions.contains) return true;
      return await b.permissions.contains({ origins: [MAL_ORIGIN] });
    } catch (_) {
      return true;
    }
  }
  async function requestMal(b = browser) {
    try {
      return await b.permissions.request({ origins: [MAL_ORIGIN] });
    } catch (_) {
      return false;
    }
  }

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

  async function doUpdate(series, { fetchFn = fetch, b = browser, onUpdate = () => {}, now = Date.now(), ttlHours = DEFAULT_TTL_HOURS } = {}) {
    const ttl = (TTL_HOURS.includes(Number(ttlHours)) ? Number(ttlHours) : DEFAULT_TTL_HOURS) * 3600000;
    const all = await load(b);
    const list = (series || []).filter((s) => s && s.id && (s.slug || s.title));
    const seen = new Set();
    const unique = list.filter((s) => !seen.has(s.id) && seen.add(s.id));

    // O AniList e o MyAnimeList andam juntos: cada lote que volta do AniList (com o ID
    // do MyAnimeList) entra na fila do MyAnimeList, que já vai consultando enquanto o
    // AniList busca o lote seguinte. Sem a permissão para api.myanimelist.net, o
    // MyAnimeList nem é tentado (a página mostra o botão para dar a permissão); sem
    // Client ID, também não.
    const malOk = clientId && (await malAllowed(b));
    const needsMal = (s) => {
      const e = all[s.id];
      if (!e || !e.al || !e.al.idMal) return false;
      const m = e.mal && e.mal.id === e.al.idMal ? e.mal : null;
      // Uma falha de outra fonte (ex.: o Jikan, que saiu) não espera o prazo.
      return !fresh(m && m.failed && m.src !== malSource() ? null : m, now, ttl, MAL_RETRY);
    };
    const queue = [];
    const queued = new Set();
    let waiters = [];
    const wake = () => {
      const w = waiters;
      waiters = [];
      w.forEach((r) => r());
    };
    const enqueue = (list) => {
      if (!malOk) return;
      for (const s of list) {
        if (!queued.has(s.id) && needsMal(s)) {
          queued.add(s.id);
          queue.push(s);
        }
      }
      wake();
    };
    let alDone = false;

    // 2. MyAnimeList: até 3 consultas ao mesmo tempo. Se o site
    // responder "pedidos demais" (429), recua para uma por vez, espera e tenta de novo.
    // 2 falhas seguidas (fora do ar): para e tenta de novo mais tarde.
    let limit = MAL_PARALLEL;
    let failures = 0;
    let changed = 0;
    const tries429 = new Map();
    const gap = MAL_GAP;
    const malFailed = (s) => {
      all[s.id].mal = { id: all[s.id].al.idMal, failed: true, src: malSource(), at: Date.now() };
    };
    async function worker(n) {
      for (;;) {
        if (n >= limit) return; // recuou: sobra só o primeiro trabalhador
        const s = queue.shift();
        if (!s) {
          if (alDone) return;
          await new Promise((r) => waiters.push(r));
          continue;
        }
        const idMal = all[s.id].al.idMal;
        if (failures >= 2) {
          malFailed(s);
          changed++;
          continue;
        }
        try {
          const r = await malScore(idMal, fetchFn);
          all[s.id].mal = { id: idMal, score: r.score, users: r.users, src: malSource(), at: Date.now() };
          failures = 0;
        } catch (err) {
          if (err && err.status === 429) {
            const t = (tries429.get(s.id) || 0) + 1;
            tries429.set(s.id, t);
            if (limit > 1) console.warn("[Watchroll] MyAnimeList: pedidos demais; uma consulta por vez");
            limit = 1;
            if (t < MAL_429_TRIES) {
              queue.unshift(s); // volta para a fila e espera o que o site pediu
              wake();
              await sleep(err.retryAfter || 5000);
              continue;
            }
          } else if (!failures) {
            console.warn("[Watchroll] MyAnimeList:", err);
          }
          malFailed(s);
          if (!(err && err.status === 429)) failures++;
        }
        changed++;
        if (changed % 5 === 0) {
          await save(all, b);
          onUpdate(all);
        }
        await sleep(gap);
      }
    }
    const workers = malOk ? Array.from({ length: limit }, (_, n) => worker(n)) : [];
    enqueue(unique); // as que já têm o AniList guardado começam na hora

    // 1. AniList, de 35 em 35 séries (grava e avisa a página a cada lote)
    const needAl = unique.filter((s) => !fresh(all[s.id] && all[s.id].al, now, ttl));
    for (let i = 0; i < needAl.length; i += BATCH) {
      const chunk = needAl.slice(i, i + BATCH);
      try {
        const found = await anilistFor(chunk, fetchFn);
        for (const s of chunk) {
          const r = found.get(s.id);
          const prev = all[s.id] || {};
          all[s.id] = { ...prev, al: r ? { ...r, at: now } : { none: true, at: now } };
        }
      } catch (err) {
        console.warn("[Watchroll] AniList:", err);
        for (const s of needAl.slice(i)) {
          const prev = all[s.id] || {};
          if (!prev.al || !prev.al.id) all[s.id] = { ...prev, al: { failed: true, at: now } };
        }
        enqueue(needAl.slice(i)); // as que já tinham o ID do MyAnimeList seguem
        await save(all, b);
        onUpdate(all);
        break; // fora do ar: tenta de novo mais tarde
      }
      enqueue(chunk);
      await save(all, b);
      onUpdate(all);
    }
    alDone = true;
    wake();
    await Promise.all(workers);
    if (changed) {
      await save(all, b);
      onUpdate(all);
    }

    // Entradas sem uso há 7 dias saem.
    for (const [id, e] of Object.entries(all)) {
      const last = Math.max((e.al && e.al.at) || 0, (e.mal && e.mal.at) || 0);
      if (now - last > 7 * DAY) delete all[id];
    }
    return all;
  }

  /**
   * A série já tem as notas (ou a resposta de que não há): o AniList respondeu e, se
   * houver ID do MyAnimeList, ele também (mal: false = sem contar o MyAnimeList).
   */
  function loaded(all, id, { mal = true } = {}) {
    const e = (all || {})[id];
    if (!e || !e.al) return false;
    if (!mal || !e.al.idMal) return true;
    return !!(e.mal && e.mal.id === e.al.idMal);
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
    loaded,
    pick,
    queryText,
    anilistFor,
    malScore,
    simplify,
    setSleep: (fn) => (sleep = fn),
    setClientId: (id) => (clientId = String(id || "").trim()),
    malAllowed,
    malActive,
    TTL_HOURS,
    ttlHoursFrom,
    requestMal,
  };
})();
