"use strict";
// Notas do AniList e do MyAnimeList (CRScores) e ordenação por nota.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeBrowser, plain } = require("./helpers");

const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });

// Exemplos reais (AniList, nov/2026).
const APOTHECARY = {
  id: 161645,
  idMal: 54492,
  averageScore: 88,
  format: "TV",
  title: { romaji: "Kusuriya no Hitorigoto", english: "The Apothecary Diaries" },
  externalLinks: [{ url: "https://www.crunchyroll.com/series/G3KHEVDJ7/the-apothecary-diaries" }],
};
const APOTHECARY_MOVIE = { id: 200929, idMal: 62844, averageScore: null, format: "MOVIE", title: { english: "The Apothecary Diaries: The Late Lady's Treasure" }, externalLinks: [] };
const ARISTOCRAT = {
  id: 164702,
  idMal: 55265,
  averageScore: 71,
  title: { romaji: "Tensei Kizoku, Kantei Skill de Nariagaru", english: "As a Reincarnated Aristocrat, I'll Use My Appraisal Skill to Rise in the World" },
  externalLinks: [{ url: "https://www.crunchyroll.com/series/GG5H5XQMD/x" }],
};

function setup(answer) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return answer(url, init.body ? JSON.parse(init.body) : null, calls);
  };
  const b = fakeBrowser();
  const ctx = load(["src/scores.js"], { browser: b });
  ctx.CRScores.setSleep(async () => {});
  ctx.CRScores.setClientId("abc123"); // Client ID de teste (o de verdade fica em mal-client.js)
  return { S: ctx.CRScores, fetchFn, calls, b };
}

// AniList falso: cada busca devolve uma lista conforme o texto.
const aniList = (bySearch) => (body) => {
  const data = {};
  for (const [k, v] of Object.entries(body.variables)) data["a" + k.slice(1)] = { media: bySearch(v) || [] };
  return json({ data });
};

describe("AniList", () => {
  test("acha a série pelo link da Crunchyroll (não pelo filme com nome parecido)", () => {
    const { S } = setup(() => json({}));
    const m = S.pick([APOTHECARY_MOVIE, APOTHECARY], { id: "G3KHEVDJ7", title: "Diários de uma Apotecária", slug: "the-apothecary-diaries" });
    assert.equal(m.id, 161645);
  });

  test("sem link: só aceita título igual; senão, nada (melhor sem nota que nota errada)", () => {
    const { S } = setup(() => json({}));
    const noLink = { ...APOTHECARY, externalLinks: [] };
    assert.equal(S.pick([noLink], { id: "X", title: "Qualquer", slug: "the-apothecary-diaries" }).id, 161645);
    assert.equal(S.pick([noLink], { id: "X", title: "Outra série", slug: "outra-serie" }), null);
  });

  test("várias temporadas com o mesmo link: vale a primeira temporada de TV (não filme nem a 3ª)", () => {
    const { S } = setup(() => json({}));
    const link = [{ url: "https://www.crunchyroll.com/series/GRDV0019R/jujutsu-kaisen" }];
    const media = [
      { id: 172463, format: "TV", startDate: { year: 2026 }, averageScore: 86, externalLinks: link },
      { id: 131573, format: "MOVIE", startDate: { year: 2021 }, averageScore: 84, externalLinks: link },
      { id: 113415, format: "TV", startDate: { year: 2020 }, averageScore: 85, externalLinks: link },
    ];
    assert.equal(S.pick(media, { id: "GRDV0019R", title: "Jujutsu Kaisen", slug: "jujutsu-kaisen" }).id, 113415);
  });

  test("título com apóstrofo bate com o slug sem ele (Journey's = journeys)", () => {
    const { S } = setup(() => json({}));
    const m = { id: 154587, title: { english: "Frieren: Beyond Journey's End", romaji: "Sousou no Frieren" }, externalLinks: [] };
    assert.equal(S.pick([m], { id: "X", title: "Frieren", slug: "frieren-beyond-journeys-end" }).id, 154587);
  });

  test("busca pelo slug (inglês), várias séries numa consulta só", async () => {
    const { S, fetchFn, calls } = setup((url, body) =>
      aniList((q) => (q === "the apothecary diaries" ? [APOTHECARY] : []))(body)
    );
    const r = await S.anilistFor(
      [
        { id: "G3KHEVDJ7", title: "Diários de uma Apotecária", slug: "the-apothecary-diaries" },
        { id: "NADA", title: "Nada", slug: "nada" },
      ],
      fetchFn
    );
    assert.deepEqual(plain(r.get("G3KHEVDJ7")), { id: 161645, score: 88, idMal: 54492 });
    assert.equal(r.get("NADA"), null);
    assert.equal(calls[0].url, "https://graphql.anilist.co");
    assert.equal(Object.keys(calls[0].body.variables).length, 2, "as duas séries na mesma consulta");
  });

  test("título longo que o AniList não acha: tenta de novo com as primeiras palavras", async () => {
    const { S, fetchFn, calls } = setup((url, body) =>
      aniList((q) => (q === "as a reincarnated aristocrat" ? [ARISTOCRAT] : []))(body)
    );
    const r = await S.anilistFor(
      [{ id: "GG5H5XQMD", title: "x", slug: "as-a-reincarnated-aristocrat-ill-use-my-appraisal-skill-to-rise-in-the-world" }],
      fetchFn
    );
    assert.equal(r.get("GG5H5XQMD").score, 71);
    assert.equal(calls.length, 2);
  });
});

describe("atualização e cache", () => {
  const series = [{ id: "G3KHEVDJ7", title: "Diários de uma Apotecária", slug: "the-apothecary-diaries" }];
  const answer = (url, body) =>
    url.startsWith("https://api.myanimelist.net/v2/anime/54492?")
      ? json({ mean: 8.87, num_scoring_users: 312345 })
      : aniList(() => [APOTHECARY])(body);

  test("AniList e depois MyAnimeList (pelo ID que o AniList deu), guardados", async () => {
    const { S, fetchFn, b } = setup(answer);
    const updates = [];
    const all = await S.update(series, { fetchFn, onUpdate: () => updates.push(1) });
    assert.deepEqual(plain(S.scoresOf(all, "G3KHEVDJ7")), { al: 88, alId: 161645, mal: 8.87, malId: 54492, malUsers: 312345 });
    assert.ok(updates.length >= 2, "a página redesenha aos poucos");
    assert.ok(b.storage.local.data[S.KEY].G3KHEVDJ7);
  });

  test("guardado e novo: não consulta de novo", async () => {
    const { S, fetchFn, calls } = setup(answer);
    await S.update(series, { fetchFn });
    const n = calls.length;
    await S.update(series, { fetchFn });
    assert.equal(calls.length, n);
  });

  test("depois de 7 dias, consulta de novo", async () => {
    const { S, fetchFn, calls } = setup(answer);
    const t0 = Date.now();
    await S.update(series, { fetchFn, now: t0 });
    const n = calls.length;
    await S.update(series, { fetchFn, now: t0 + 8 * 86400000 });
    assert.ok(calls.length > n);
  });

  test("MyAnimeList fora do ar: fica a nota do AniList, MyAnimeList tenta de novo depois", async () => {
    const { S, fetchFn } = setup((url, body) => (url.includes("myanimelist") ? json({}, 503) : aniList(() => [APOTHECARY])(body)));
    const all = await S.update(series, { fetchFn });
    const sc = S.scoresOf(all, "G3KHEVDJ7");
    assert.equal(sc.al, 88);
    assert.equal(sc.mal, null);
    assert.equal(all.G3KHEVDJ7.mal.failed, true);
  });

  test("MyAnimeList sem responder: depois de 2 falhas seguidas, não insiste nas outras séries", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: "S" + i, title: "T" + i, slug: "t" + i }));
    const { S, fetchFn, calls } = setup((url, body) => {
      if (url.includes("myanimelist")) throw new Error("timeout");
      return aniList((q) => [{ id: Number(q.slice(1)) + 1, idMal: 100 + Number(q.slice(1)), averageScore: 70, title: { english: q.toUpperCase() }, externalLinks: [{ url: "https://www.crunchyroll.com/series/S" + q.slice(1) + "/x" }] }])(body);
    });
    const all = await S.update(many, { fetchFn });
    // As 3 consultas em paralelo já saíram; depois das 2 falhas, nenhuma outra.
    assert.ok(calls.filter((c) => c.url.includes("myanimelist")).length <= 3);
    assert.ok(many.every((s) => all[s.id].mal && all[s.id].mal.failed), "tenta de novo outro dia");
    assert.ok(many.every((s) => S.scoresOf(all, s.id).al === 70), "as notas do AniList ficam");
  });

  test("limite do AniList (HTTP 429): espera o Retry-After e tenta de novo", async () => {
    let first = true;
    const waits = [];
    const { S, fetchFn } = setup((url, body) => {
      if (url.includes("myanimelist")) return json({ mean: 8.87, num_scoring_users: 1 });
      if (first) {
        first = false;
        return { ok: false, status: 429, headers: { get: (h) => (h === "retry-after" ? "7" : null) }, json: async () => ({}) };
      }
      return aniList(() => [APOTHECARY])(body);
    });
    S.setSleep(async (ms) => waits.push(ms));
    const all = await S.update(series, { fetchFn });
    assert.equal(S.scoresOf(all, "G3KHEVDJ7").al, 88);
    assert.ok(waits.includes(7000));
  });

  test("API oficial do MyAnimeList: campos, cabeçalho do Client ID e sem cookies", async () => {
    const { S, fetchFn, calls } = setup((url, body) =>
      url.startsWith("https://api.myanimelist.net/v2/anime/54492?")
        ? json({ id: 54492, mean: 8.88, num_scoring_users: 400000 })
        : aniList(() => [APOTHECARY])(body)
    );
    S.setClientId("abc123");
    const all = await S.update(series, { fetchFn });
    const sc = S.scoresOf(all, "G3KHEVDJ7");
    assert.equal(sc.mal, 8.88);
    assert.equal(sc.malUsers, 400000);
    const mal = calls.find((c) => c.url.includes("myanimelist"));
    assert.match(mal.url, /fields=mean,num_scoring_users/);
    assert.equal(mal.init.headers["X-MAL-CLIENT-ID"], "abc123");
    assert.equal(mal.init.credentials, "omit");
  });

  test("falha guardada de outra fonte (o Jikan, que saiu): tenta logo na API oficial", async () => {
    const { S, fetchFn, b } = setup((url, body) => (url.includes("myanimelist") ? json({ mean: 8.88, num_scoring_users: 1 }) : aniList(() => [APOTHECARY])(body)));
    const now = Date.now();
    await b.storage.local.set({
      [S.KEY]: { G3KHEVDJ7: { al: { id: 161645, score: 88, idMal: 54492, at: now }, mal: { id: 54492, failed: true, src: "jikan", at: now } } },
    });
    const all = await S.update(series, { fetchFn, b });
    assert.equal(S.scoresOf(all, "G3KHEVDJ7").mal, 8.88);
  });

  test("sem Client ID: não consulta o MyAnimeList nem marca falha", async () => {
    const { S, fetchFn, calls } = setup((url, body) => (url.includes("myanimelist") ? json({ mean: 8.88 }) : aniList(() => [APOTHECARY])(body)));
    S.setClientId("");
    assert.equal(S.malActive(), false);
    const all = await S.update(series, { fetchFn });
    assert.equal(S.scoresOf(all, "G3KHEVDJ7").al, 88);
    assert.ok(!calls.some((c) => c.url.includes("myanimelist")));
    assert.equal(all.G3KHEVDJ7.mal, undefined);
    assert.ok(!calls.some((c) => c.url.includes("jikan")), "o Jikan não é mais usado");
  });

  test("sem a permissão para api.myanimelist.net: não tenta nem marca falha", async () => {
    const { S, fetchFn, calls, b } = setup((url, body) => (url.includes("myanimelist") ? json({ mean: 8.88 }) : aniList(() => [APOTHECARY])(body)));
    S.setClientId("abc123");
    let allowed = false;
    b.permissions = { contains: async () => allowed };
    let all = await S.update(series, { fetchFn, b });
    assert.ok(!calls.some((c) => c.url.includes("myanimelist")));
    assert.equal(all.G3KHEVDJ7.mal, undefined);
    allowed = true;
    all = await S.update(series, { fetchFn, b });
    assert.equal(S.scoresOf(all, "G3KHEVDJ7").mal, 8.88);
  });

  test("falha na API oficial: tenta de novo depois de 1 hora (não 1 dia)", async () => {
    let up = false;
    const { S, fetchFn } = setup((url, body) => (url.includes("myanimelist") ? (up ? json({ mean: 8.88 }) : json({}, 500)) : aniList(() => [APOTHECARY])(body)));
    S.setClientId("abc123");
    const t0 = Date.now();
    await S.update(series, { fetchFn, now: t0 });
    up = true;
    let all = await S.update(series, { fetchFn, now: t0 + 30 * 60000 });
    assert.equal(S.scoresOf(all, "G3KHEVDJ7").mal, null);
    all = await S.update(series, { fetchFn, now: t0 + 2 * 3600000 });
    assert.equal(S.scoresOf(all, "G3KHEVDJ7").mal, 8.88);
  });

  test("API oficial do MyAnimeList: série sem nota (404) não é falha", async () => {
    const { S, fetchFn } = setup((url, body) => (url.includes("myanimelist") ? json({}, 404) : aniList(() => [APOTHECARY])(body)));
    S.setClientId("abc123");
    const all = await S.update(series, { fetchFn });
    assert.equal(S.scoresOf(all, "G3KHEVDJ7").mal, null);
    assert.ok(!all.G3KHEVDJ7.mal.failed);
  });

  test("prazo configurável (4 h): depois de 5 h consulta de novo; com 3 h, não", async () => {
    const { S, fetchFn, calls } = setup(answer);
    const t0 = Date.now();
    await S.update(series, { fetchFn, now: t0, ttlHours: 4 });
    const n = calls.length;
    await S.update(series, { fetchFn, now: t0 + 3 * 3600000, ttlHours: 4 });
    assert.equal(calls.length, n);
    await S.update(series, { fetchFn, now: t0 + 5 * 3600000, ttlHours: 4 });
    assert.ok(calls.length > n);
  });

  test("prazo padrão é 24 h; valores fora de 4, 8, 12 e 24 voltam ao padrão", async () => {
    const { S, fetchFn, calls } = setup(answer);
    assert.deepEqual(plain(S.TTL_HOURS), [4, 8, 12, 24]);
    assert.equal(S.ttlHoursFrom({}), 24);
    assert.equal(S.ttlHoursFrom({ scoresTtlHours: "8" }), 8);
    assert.equal(S.ttlHoursFrom({ scoresTtlHours: 5 }), 24);
    const t0 = Date.now();
    await S.update(series, { fetchFn, now: t0 });
    const n = calls.length;
    await S.update(series, { fetchFn, now: t0 + 23 * 3600000 });
    assert.equal(calls.length, n);
    await S.update(series, { fetchFn, now: t0 + 25 * 3600000 });
    assert.ok(calls.length > n);
  });

  test("loaded: só com o AniList e o MyAnimeList respondidos (ou sem ID do MyAnimeList)", () => {
    const { S } = setup(() => json({}));
    const all = {
      A: { al: { id: 1, score: 80, idMal: 10 }, mal: { id: 10, score: 8 } },
      B: { al: { id: 2, score: 70, idMal: 20 } },
      C: { al: { none: true } },
      D: { al: { id: 4, score: 60, idMal: 40 }, mal: { id: 40, failed: true } },
    };
    assert.equal(S.loaded(all, "A"), true);
    assert.equal(S.loaded(all, "B"), false, "falta o MyAnimeList");
    assert.equal(S.loaded(all, "B", { mal: false }), true, "sem permissão, não espera o MyAnimeList");
    assert.equal(S.loaded(all, "C"), true, "não achada no AniList: nada mais a esperar");
    assert.equal(S.loaded(all, "D"), true, "falha também encerra a espera");
    assert.equal(S.loaded(all, "E"), false);
  });

  test("até 35 séries numa consulta ao AniList", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: "S" + i, title: "T" + i, slug: "t" + i }));
    const { S, fetchFn, calls } = setup((url, body) => aniList(() => [])(body));
    await S.anilistFor(many.slice(0, 35), fetchFn);
    assert.equal(Object.keys(calls[0].body.variables).length, 35);
  });

  test("consulta complexa demais para o AniList (HTTP 400): divide ao meio e tenta de novo", async () => {
    const many = Array.from({ length: 35 }, (_, i) => ({ id: "S" + i, title: "T" + i, slug: "t" + i }));
    const { S, fetchFn, calls } = setup((url, body) =>
      Object.keys(body.variables).length > 20
        ? json({ errors: [{ message: "Max query complexity should be 500 but got 507." }] }, 400)
        : aniList((q) => (q === "t3" ? [{ id: 9, idMal: 90, averageScore: 77, title: { english: "T3" }, externalLinks: [] }] : []))(body)
    );
    const r = await S.anilistFor(many, fetchFn);
    assert.equal(r.get("S3").score, 77);
    assert.deepEqual(calls.slice(0, 3).map((c) => Object.keys(c.body.variables).length), [35, 18, 17]);
  });

  // Séries falsas: o AniList acha todas (link da Crunchyroll) com ID do MyAnimeList 100+i.
  const fakeSeries = (n) => Array.from({ length: n }, (_, i) => ({ id: "S" + i, title: "T" + i, slug: "t" + i }));
  const aniAll = aniList((q) => [
    { id: Number(q.slice(1)) + 1, idMal: 100 + Number(q.slice(1)), averageScore: 70, title: { english: q.toUpperCase() }, externalLinks: [{ url: "https://www.crunchyroll.com/series/S" + q.slice(1) + "/x" }] },
  ]);
  const later = (v, ms = 5) => new Promise((r) => setTimeout(() => r(v), ms));

  test("MyAnimeList começa assim que o primeiro lote do AniList volta (não espera todos)", async () => {
    const { S, fetchFn, calls } = setup((url, body) => (url.includes("myanimelist") ? json({ mean: 8 }) : aniAll(body)));
    S.setClientId("abc123");
    const all = await S.update(fakeSeries(40), { fetchFn });
    const kinds = calls.map((c) => (c.url.includes("myanimelist") ? "mal" : "al"));
    const secondAl = kinds.indexOf("al", kinds.indexOf("al") + 1);
    assert.ok(secondAl > 0, "dois lotes no AniList (35 + 5)");
    assert.ok(kinds.indexOf("mal") < secondAl, `MyAnimeList antes do 2º lote do AniList: ${kinds.join(",")}`);
    assert.equal(kinds.filter((k) => k === "mal").length, 40);
    assert.ok(fakeSeries(40).every((s) => S.scoresOf(all, s.id).mal === 8));
  });

  test("API oficial do MyAnimeList: até 3 consultas ao mesmo tempo", async () => {
    let inFlight = 0;
    let max = 0;
    const { S, fetchFn } = setup(async (url, body) => {
      if (!url.includes("myanimelist")) return aniAll(body);
      max = Math.max(max, ++inFlight);
      const r = await later(json({ mean: 7.5 }));
      inFlight--;
      return r;
    });
    S.setClientId("abc123");
    const all = await S.update(fakeSeries(12), { fetchFn });
    assert.equal(max, 3);
    assert.ok(fakeSeries(12).every((s) => S.scoresOf(all, s.id).mal === 7.5));
  });

  test("MyAnimeList responde 'pedidos demais' (429): recua para uma por vez, espera e não perde a nota", async () => {
    let got429At = null;
    const spans = []; // [início, fim] de cada consulta ao MyAnimeList
    const waits = [];
    const { S, fetchFn } = setup(async (url, body) => {
      if (!url.includes("myanimelist")) return aniAll(body);
      const span = [performance.now(), null];
      spans.push(span);
      let r;
      if (got429At == null && url.includes("/anime/101?")) {
        r = await later({ ok: false, status: 429, headers: { get: (h) => (h === "retry-after" ? "2" : null) }, json: async () => ({}) });
        got429At = performance.now();
      } else r = await later(json({ mean: 9 }));
      span[1] = performance.now();
      return r;
    });
    S.setClientId("abc123");
    S.setSleep(async (ms) => {
      waits.push(ms);
      await later(null, 1);
    });
    const all = await S.update(fakeSeries(10), { fetchFn });
    assert.ok(waits.includes(2000), "esperou o Retry-After");
    assert.equal(S.scoresOf(all, "S1").mal, 9, "a série do 429 foi consultada de novo");
    assert.ok(fakeSeries(10).every((s) => S.scoresOf(all, s.id).mal === 9));
    // Depois do 429, as consultas novas não se sobrepõem (uma por vez).
    const after = spans.filter(([a]) => a >= got429At).sort((x, y) => x[0] - y[0]);
    assert.ok(after.length > 1);
    for (let i = 1; i < after.length; i++) assert.ok(after[i][0] >= after[i - 1][1], "uma por vez depois do 429");
  });

  test("cancelada (a pesquisa mudou): para no próximo ponto seguro e guarda o que já veio", async () => {
    let stop = false;
    const { S, fetchFn, calls, b } = setup((url, body) => {
      if (url.includes("myanimelist")) {
        stop = true; // a página desistiu logo depois da primeira nota do MyAnimeList
        return json({ mean: 8 });
      }
      return aniAll(body);
    });
    const all = await S.update(fakeSeries(80), { fetchFn, shouldStop: () => stop });
    const al = calls.filter((c) => !c.url.includes("myanimelist")).length;
    const mal = calls.filter((c) => c.url.includes("myanimelist")).length;
    assert.equal(al, 1, "não pede os outros lotes do AniList");
    assert.ok(mal <= 3, "só as consultas que já tinham saído");
    assert.equal(S.scoresOf(all, "S0").al, 70);
    assert.ok(b.storage.local.data[S.KEY].S0, "o que veio fica no cache");
    assert.equal(S.scoresOf(all, "S70").al, null, "o resto fica para depois");
  });

  test("AniList fora do ar: nada quebra", async () => {
    const { S, fetchFn } = setup(() => json({}, 500));
    const all = await S.update(series, { fetchFn });
    assert.equal(S.scoresOf(all, "G3KHEVDJ7").al, null);
  });
});

describe("ordenação por nota", () => {
  const ctx = load(["src/i18n.js", "src/checker.js"], { browser: fakeBrowser() });
  const C = ctx.CRChecker;
  const list = [
    { title: "B", seriesId: "B", n: 7.1 },
    { title: "A", seriesId: "A", n: null },
    { title: "C", seriesId: "C", n: 8.9 },
  ];
  test("maior nota primeiro; sem nota vai para o fim", () => {
    const r = C.sortResults(list, "malScore", (s) => s.n);
    assert.deepEqual(plain(r.map((s) => s.title)), ["C", "B", "A"]);
  });
  test("ordenações por nota em todas as abas de séries", () => {
    for (const tab of ["toWatch", "waitDub", "waitSub", "upToDate", "never", "hidden"]) {
      assert.ok(["crScore", "alScore", "malScore"].every((k) => C.sortsFor({}, tab).includes(k)), tab);
    }
    assert.equal(C.sortFor({ sortByTab: { toWatch: "malScore" } }, "toWatch"), "malScore");
  });
});
