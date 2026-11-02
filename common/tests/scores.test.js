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
    url.startsWith("https://api.jikan.moe/v4/anime/54492")
      ? json({ data: { score: 8.87, scored_by: 312345 } })
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

  test("Jikan fora do ar: fica a nota do AniList, MyAnimeList tenta de novo depois", async () => {
    const { S, fetchFn } = setup((url, body) => (url.includes("jikan") ? json({}, 503) : aniList(() => [APOTHECARY])(body)));
    const all = await S.update(series, { fetchFn });
    const sc = S.scoresOf(all, "G3KHEVDJ7");
    assert.equal(sc.al, 88);
    assert.equal(sc.mal, null);
    assert.equal(all.G3KHEVDJ7.mal.failed, true);
  });

  test("Jikan sem responder: depois de 2 falhas seguidas, não insiste nas outras séries", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: "S" + i, title: "T" + i, slug: "t" + i }));
    const { S, fetchFn, calls } = setup((url, body) => {
      if (url.includes("jikan")) throw new Error("timeout");
      return aniList((q) => [{ id: Number(q.slice(1)) + 1, idMal: 100 + Number(q.slice(1)), averageScore: 70, title: { english: q.toUpperCase() }, externalLinks: [{ url: "https://www.crunchyroll.com/series/S" + q.slice(1) + "/x" }] }])(body);
    });
    const all = await S.update(many, { fetchFn });
    assert.equal(calls.filter((c) => c.url.includes("jikan")).length, 2);
    assert.ok(many.every((s) => all[s.id].mal && all[s.id].mal.failed), "tenta de novo outro dia");
    assert.ok(many.every((s) => S.scoresOf(all, s.id).al === 70), "as notas do AniList ficam");
  });

  test("limite do AniList (HTTP 429): espera o Retry-After e tenta de novo", async () => {
    let first = true;
    const waits = [];
    const { S, fetchFn } = setup((url, body) => {
      if (url.includes("jikan")) return json({ data: { score: 8.87, scored_by: 1 } });
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

  test("com Client ID: usa a API oficial do MyAnimeList (e não o Jikan)", async () => {
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
    assert.ok(!calls.some((c) => c.url.includes("jikan")));
  });

  test("falhou no Jikan e depois ganhou Client ID: tenta logo na API oficial", async () => {
    const { S, fetchFn } = setup((url, body) =>
      url.includes("jikan") ? json({}, 503) : url.includes("myanimelist") ? json({ mean: 8.88, num_scoring_users: 1 }) : aniList(() => [APOTHECARY])(body)
    );
    let all = await S.update(series, { fetchFn });
    assert.equal(all.G3KHEVDJ7.mal.failed, true);
    S.setClientId("abc123");
    all = await S.update(series, { fetchFn });
    assert.equal(S.scoresOf(all, "G3KHEVDJ7").mal, 8.88);
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
