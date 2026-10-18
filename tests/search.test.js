"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { load, plain } = require("./helpers");

const item = (id, { title = id, type = "series", year = 2023, rating = "A14", audios = ["ja-JP"], ...rest } = {}) => ({
  id,
  type,
  title,
  slug_title: id.toLowerCase(),
  images: { poster_wide: [[{ source: `https://img/${id}-320.jpg`, width: 320 }, { source: `https://img/${id}-640.jpg`, width: 640 }]] },
  [type === "movie_listing" ? "movie_listing_metadata" : "series_metadata"]: {
    series_launch_year: year,
    maturity_ratings: rating == null ? [] : [rating],
    audio_locales: audios,
    subtitle_locales: ["pt-BR"],
    episode_count: 12,
    season_count: 1,
  },
  ...rest,
});

function setup(db = {}) {
  const calls = [];
  const CRApi = {
    search: async (q, locale, opts) => (calls.push(["search", q, opts && opts.preferredAudio]), (db.search || {})[q] || []),
    browse: async (params) => {
      calls.push(["browse", { ...params }]);
      const all = (db.browse && db.browse(params)) || [];
      const start = params.start || 0;
      return { items: all.slice(start, start + params.n), total: all.length };
    },
    objects: async (ids) => (calls.push(["objects", ids.slice()]), ids.map((id) => (db.objects || {})[id]).filter(Boolean)),
    seasonList: async () => db.seasonList || [],
  };
  const ctx = load(["src/search.js"], { CRApi });
  return { S: ctx.CRSearch, calls };
}
const settings = { locale: "pt-BR", dubLang: "pt-BR" };
const titles = (r) => plain(r.items.map((x) => x.title));

describe("normalização e classificação", () => {
  const { S } = setup();
  test("classificação indicativa: L, A10…A18 e números soltos", () => {
    const age = (r) => S.ratingAge({ maturity_ratings: [r] });
    assert.equal(age("L"), 0);
    assert.equal(age("A10"), 10);
    assert.equal(age("A14"), 14);
    assert.equal(age("18"), 18);
    assert.equal(S.ratingAge({ extended_maturity_rating: { rating: "A16" }, maturity_ratings: ["A14"] }), 16, "extended tem prioridade");
    assert.equal(S.ratingAge({}), null);
  });

  test("normaliza série e filme da resposta real", () => {
    const r = S.normalize(item("G1", { audios: ["ja-JP", "pt-BR"] }), new Set(["G1"]));
    assert.equal(r.type, "series");
    assert.equal(r.year, 2023);
    assert.equal(r.age, 14);
    assert.equal(r.image, "https://img/G1-320.jpg");
    assert.equal(r.inWatchlist, true);
    const m = S.normalize(item("M1", { type: "movie_listing" }), new Set());
    assert.equal(m.type, "movie");
    assert.equal(m.inWatchlist, false);
  });

  test("reconhece texto em japonês", () => {
    assert.equal(S.hasCJK("薬屋のひとりごと"), true);
    assert.equal(S.hasCJK("フリーレン"), true);
    assert.equal(S.hasCJK("Kusuriya no Hitorigoto"), false);
  });

  test("tira o ID da Crunchyroll dos links do AniList", () => {
    assert.deepEqual(
      plain(
        S.crIdsFromLinks([
          { site: "Crunchyroll", url: "https://www.crunchyroll.com/series/G3KHEVDJ7/the-apothecary-diaries" },
          { site: "Crunchyroll", url: "https://www.crunchyroll.com/pt-br/series/GG5H5XQX4/frieren" },
          { site: "Netflix", url: "https://www.netflix.com/title/1" },
          { site: "Crunchyroll", url: "https://www.crunchyroll.com/series/G3KHEVDJ7/the-apothecary-diaries" },
        ])
      ),
      ["G3KHEVDJ7", "GG5H5XQX4"]
    );
  });
});

describe("filtros", () => {
  const { S } = setup();
  const r = (o) => S.normalize(item("X", o), new Set(o && o.mine ? ["X"] : []));
  test("dublado no idioma escolhido, não só 'tem alguma dublagem'", () => {
    assert.equal(S.matches(r({ audios: ["ja-JP", "en-US"] }), { dub: "dub" }, "pt-BR"), false);
    assert.equal(S.matches(r({ audios: ["ja-JP", "pt-BR"] }), { dub: "dub" }, "pt-BR"), true);
    assert.equal(S.matches(r({ audios: ["ja-JP", "en-US"] }), { dub: "nodub" }, "pt-BR"), true);
  });
  test("classificação: até a idade escolhida; sem classificação fica de fora", () => {
    assert.equal(S.matches(r({ rating: "A14" }), { maxAge: 14 }, "pt-BR"), true);
    assert.equal(S.matches(r({ rating: "A16" }), { maxAge: 14 }, "pt-BR"), false);
    assert.equal(S.matches(r({ rating: "L" }), { maxAge: 0 }, "pt-BR"), true);
    assert.equal(S.matches(r({ rating: null }), { maxAge: 18 }, "pt-BR"), false);
    assert.equal(S.matches(r({ rating: null }), {}, "pt-BR"), true);
  });
  test("ano de estreia e escopo da Fila", () => {
    assert.equal(S.matches(r({ year: 2023 }), { year: "2023" }, "pt-BR"), true);
    assert.equal(S.matches(r({ year: 2022 }), { year: 2023 }, "pt-BR"), false);
    assert.equal(S.matches(r({}), { scope: "mine" }, "pt-BR"), false);
    assert.equal(S.matches(r({ mine: true }), { scope: "mine" }, "pt-BR"), true);
  });
});

describe("pesquisa", () => {
  test("texto: busca da Crunchyroll com o idioma de dublagem preferido", async () => {
    const { S, calls } = setup({ search: { frieren: [item("F", { title: "Frieren" })] } });
    const r = await S.run({ q: " frieren ", settings });
    assert.deepEqual(titles(r), ["Frieren"]);
    assert.deepEqual(plain(calls[0]), ["search", "frieren", "pt-BR"]);
    assert.equal(r.anilist, "off");
  });

  test("texto + AniList: acrescenta o que só o AniList achou (romaji)", async () => {
    const { S, calls } = setup({
      search: { "kusuriya no hitorigoto": [item("OUTRA", { title: "Non Non Biyori" })] },
      objects: { G3KHEVDJ7: item("G3KHEVDJ7", { title: "Diários de uma Apotecária" }) },
    });
    const fetchFn = async (url, init) => {
      assert.equal(url, "https://graphql.anilist.co");
      assert.equal(JSON.parse(init.body).variables.s, "kusuriya no hitorigoto");
      return {
        ok: true,
        json: async () => ({
          data: { Page: { media: [{ externalLinks: [{ site: "Crunchyroll", url: "https://www.crunchyroll.com/series/G3KHEVDJ7/the-apothecary-diaries" }] }] } },
        }),
      };
    };
    const r = await S.run({ q: "kusuriya no hitorigoto", settings, useAniList: true, fetchFn });
    assert.deepEqual(titles(r), ["Diários de uma Apotecária", "Non Non Biyori"], "o achado do AniList vem antes dos aproximados");
    assert.deepEqual(plain(calls.find((c) => c[0] === "objects")), ["objects", ["G3KHEVDJ7"]]);
    assert.equal(r.anilist, "used");
  });

  test("texto em kanji: o resultado do AniList vem primeiro", async () => {
    const { S } = setup({
      search: { "薬屋のひとりごと": [item("LIXO", { title: "Qualquer" })] },
      objects: { G3KHEVDJ7: item("G3KHEVDJ7", { title: "Diários de uma Apotecária" }) },
    });
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({ data: { Page: { media: [{ externalLinks: [{ site: "Crunchyroll", url: "https://www.crunchyroll.com/series/G3KHEVDJ7/x" }] }] } } }),
    });
    const r = await S.run({ q: "薬屋のひとりごと", settings, useAniList: true, fetchFn });
    assert.equal(r.items[0].title, "Diários de uma Apotecária");
  });

  test("AniList acha uma série que a busca da Crunchyroll também trouxe: sobe para o topo, sem repetir", async () => {
    const { S, calls } = setup({
      search: { frieren: [item("K", { title: "Kemono Friends" }), item("F", { title: "Frieren" })] },
    });
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({ data: { Page: { media: [{ externalLinks: [{ site: "Crunchyroll", url: "https://www.crunchyroll.com/series/F/frieren" }] }] } } }),
    });
    const r = await S.run({ q: "frieren", settings, useAniList: true, fetchFn });
    assert.deepEqual(titles(r), ["Frieren", "Kemono Friends"]);
    assert.ok(!calls.some((c) => c[0] === "objects"), "não busca de novo o que já veio");
  });

  test("AniList fora do ar: segue com a busca da Crunchyroll e avisa", async () => {
    const { S } = setup({ search: { frieren: [item("F", { title: "Frieren" })] } });
    const r = await S.run({ q: "frieren", settings, useAniList: true, fetchFn: async () => ({ ok: false, status: 503 }) });
    assert.deepEqual(titles(r), ["Frieren"]);
    assert.equal(r.anilist, "error");
  });

  test("sem texto, com temporada: navegação filtrada pelo servidor, todas as páginas", async () => {
    const list = Array.from({ length: 130 }, (_, i) => item(`S${i}`));
    const { S, calls } = setup({ browse: (p) => (p.seasonal_tag === "fall-2026" ? list : []) });
    const r = await S.run({ filters: { season: "fall-2026" }, settings });
    assert.equal(r.items.length, 130);
    assert.deepEqual(plain(calls.map((c) => c[1].start)), [0, 100]);
    assert.ok(calls.every((c) => c[1].seasonal_tag === "fall-2026"));
  });

  test("texto + temporada: cruza a busca com a lista da temporada", async () => {
    const { S } = setup({
      search: { diaries: [item("A", { title: "Apothecary" }), item("B", { title: "Slime Diaries" })] },
      browse: (p) => (p.seasonal_tag === "fall-2023" ? [item("A")] : []),
    });
    const r = await S.run({ q: "diaries", filters: { season: "fall-2023" }, settings });
    assert.deepEqual(titles(r), ["Apothecary"]);
  });

  test("sem texto, com ano: catálogo inteiro filtrado pelo ano de estreia", async () => {
    const cat = [item("NOVA", { year: 2023 }), item("ANTIGA", { year: 2019 }), item("OUTRA", { year: 2023 })];
    const { S } = setup({ browse: () => cat });
    const r = await S.run({ filters: { year: 2023 }, settings });
    assert.deepEqual(titles(r), ["NOVA", "OUTRA"]);
  });

  test("sem texto, só a Fila: busca as séries da Fila pelo ID e aplica os filtros", async () => {
    const { S, calls } = setup({
      objects: {
        A: item("A", { title: "Dublada", audios: ["pt-BR"] }),
        B: item("B", { title: "Só legendada", audios: ["ja-JP"] }),
      },
    });
    const r = await S.run({ filters: { scope: "mine", dub: "dub" }, settings, watchIds: new Set(["A", "B"]) });
    assert.deepEqual(titles(r), ["Dublada"]);
    assert.equal(calls[0][0], "objects");
    assert.ok(r.items[0].inWatchlist);
  });

  test("sem texto: baixa o catálogo inteiro em paralelo e filtra tudo localmente", async () => {
    const cat = Array.from({ length: 450 }, (_, i) => item(`P${i}`, { audios: i % 2 ? ["pt-BR"] : ["ja-JP"] }));
    const { S, calls } = setup({ browse: () => cat });
    const r = await S.run({ filters: { dub: "dub" }, settings: { ...settings, concurrency: 8 } });
    assert.equal(r.items.length, 225, "todos os dublados do catálogo, não só os da 1ª página");
    assert.deepEqual(plain(calls.map((c) => c[1].start)).sort((a, b) => a - b), [0, 100, 200, 300, 400]);
    assert.ok(calls.every((c) => c[1].is_dubbed === undefined), "não usa o is_dubbed do servidor (desatualizado)");
  });

  test("regressão (dados reais): série em 1.714º no ranking e fora do is_dubbed aparece no filtro", async () => {
    const cat = Array.from({ length: 1929 }, (_, i) => item(`X${i}`, { rating: "A16", audios: ["ja-JP"] }));
    cat[1713] = item("GT00258001", { title: "Witch Hat Atelier", year: 2026, rating: "A12", audios: ["fr-FR", "ja-JP", "pt-BR", "en-US"] });
    const { S } = setup({ browse: () => cat });
    const r = await S.run({ filters: { dub: "dub", maxAge: "12" }, settings });
    assert.deepEqual(titles(r), ["Witch Hat Atelier"]);
  });

  test("o catálogo fica guardado: a segunda pesquisa não consulta de novo", async () => {
    const { S, calls } = setup({ browse: () => [item("A"), item("B")] });
    await S.run({ filters: {}, settings });
    const n = calls.length;
    await S.run({ filters: { maxAge: "14" }, settings });
    assert.equal(calls.length, n);
    await S.run({ filters: {}, settings, force: true });
    assert.ok(calls.length > n, "force: baixa de novo");
  });

  test("ordenação: padrão, ano de estreia (mais novo) e título", async () => {
    const cat = [item("B", { title: "Beta", year: 2020 }), item("A", { title: "Alfa", year: 2024 }), item("C", { title: "Gama", year: 2024 })];
    const { S } = setup({ browse: () => cat });
    assert.deepEqual(titles(await S.run({ filters: {}, settings })), ["Beta", "Alfa", "Gama"]);
    assert.deepEqual(titles(await S.run({ filters: { sort: "year" }, settings })), ["Alfa", "Gama", "Beta"]);
    assert.deepEqual(titles(await S.run({ filters: { sort: "title" }, settings })), ["Alfa", "Beta", "Gama"]);
  });

  test("ignora episódios e repetidos", async () => {
    const { S } = setup({ search: { x: [item("A"), item("A"), { id: "E", type: "episode", title: "ep" }] } });
    const r = await S.run({ q: "x", settings });
    assert.equal(r.items.length, 1);
  });

  test("temporadas com o nome traduzido pela Crunchyroll", async () => {
    const { S } = setup({ seasonList: [{ id: "fall-2026", localization: { title: "Outono 2026" } }, { id: "summer-2026" }] });
    assert.deepEqual(plain(await S.seasons("pt-BR")), [
      { id: "fall-2026", title: "Outono 2026" },
      { id: "summer-2026", title: "summer-2026" },
    ]);
  });
});
