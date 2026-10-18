"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeBrowser, episode, playhead, DAY, plain } = require("./helpers");

const FULL = 24 * 60; // duração dos episódios de teste, em segundos

/** Monta o analisador com uma API falsa servida a partir de `db`. */
function setup(db) {
  const calls = [];
  const CRApi = {
    getAccountId: async () => "conta-1",
    watchlist: async () => (calls.push(["watchlist"]), db.watchlist),
    customListItems: async (id) => {
      calls.push(["customList", id]);
      if ((db.missingLists || []).includes(id)) throw Object.assign(new Error("HTTP 404"), { status: 404 });
      if ((db.brokenLists || []).includes(id)) throw Object.assign(new Error("HTTP 500"), { status: 500 });
      return (db.lists || {})[id] || [];
    },
    seasons: async (id) => {
      calls.push(["seasons", id]);
      if (db.fail && db.fail.includes(id)) throw new Error("HTTP 500 em seasons");
      return db.seasons[id] || [];
    },
    episodes: async (id) => (calls.push(["episodes", id]), db.episodes[id] || []),
    movieListing: async (id) => (calls.push(["movieListing", id]), (db.movieListings || {})[id] || null),
    movies: async (id) => (calls.push(["movies", id]), (db.movies || {})[id] || []),
    playheads: async (ids) => {
      calls.push(["playheads", ids.length]);
      return new Map(ids.filter((i) => db.playheads[i]).map((i) => [i, db.playheads[i]]));
    },
  };
  const browser = fakeBrowser();
  // console.warn silenciado: um teste simula erro de propósito.
  const quiet = { ...console, warn: () => {} };
  const ctx = load(["src/analyzer.js"], { browser, CRApi, console: quiet });
  return { analyzer: ctx.CRAnalyzer, calls, browser };
}

const settings = (over = {}) => ({
  locale: "pt-BR",
  dubLang: "pt-BR",
  defaultMode: "auto",
  seriesModes: {},
  ...over,
});
const series = (id, extra = {}) => ({ panel: { type: "series", id, title: `Série ${id}`, slug_title: id }, ...extra });
const ids = (r) => plain(r.pending.map((p) => p.id));

describe("estado de cada série", () => {
  test("o bug relatado: Crunchyroll diz 'nunca assistida', mas tudo foi visto → em dia", async () => {
    const { analyzer } = setup({
      watchlist: [series("A", { never_watched: true })],
      seasons: { A: [{ id: "A1", season_sequence_number: 1 }] },
      episodes: { A1: [episode("a1", 1), episode("a2", 2)] },
      playheads: { a1: playhead("a1", FULL, true), a2: playhead("a2", FULL, true) },
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.status, "uptodate");
    assert.deepEqual(ids(r), []);
  });

  test("lista os episódios disponíveis depois do último visto", async () => {
    const { analyzer } = setup({
      watchlist: [series("A")],
      seasons: { A: [{ id: "A1", season_sequence_number: 1 }] },
      episodes: { A1: [1, 2, 3, 4].map((n) => episode(`a${n}`, n)) },
      playheads: { a1: playhead("a1", FULL, true), a2: playhead("a2", FULL, true) },
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.status, "pending");
    assert.deepEqual(ids(r), ["a3", "a4"]);
    assert.equal(r.pending[0].number, "3");
    assert.match(r.pending[0].thumb, /a3\.jpg$/);
  });

  test("episódio começado aparece como 'em andamento' com o progresso", async () => {
    const { analyzer } = setup({
      watchlist: [series("A")],
      seasons: { A: [{ id: "A1", season_sequence_number: 1 }] },
      episodes: { A1: [episode("a1", 1), episode("a2", 2)] },
      playheads: { a1: playhead("a1", FULL / 2) },
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.deepEqual(ids(r), ["a1", "a2"]);
    assert.equal(r.pending[0].inProgress, true);
    assert.equal(r.pending[0].progress, 0.5);
    assert.equal(r.pending[1].inProgress, false);
  });

  test("passar de 90% conta como assistido mesmo sem fully_watched", async () => {
    const { analyzer } = setup({
      watchlist: [series("A")],
      seasons: { A: [{ id: "A1", season_sequence_number: 1 }] },
      episodes: { A1: [episode("a1", 1)] },
      playheads: { a1: playhead("a1", FULL * 0.95, false) },
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.status, "uptodate");
  });

  test("ignora episódios futuros, indisponíveis e clipes", async () => {
    const now = Date.now();
    const { analyzer } = setup({
      watchlist: [series("A")],
      seasons: { A: [{ id: "A1", season_sequence_number: 1 }] },
      episodes: {
        A1: [
          episode("a1", 1),
          episode("a2", 2, { availableAt: now + 3 * DAY }),
          episode("a3", 3, { status: "unavailable" }),
          episode("clip", 4, { clip: true }),
        ],
      },
      playheads: { a1: playhead("a1", FULL, true) },
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.status, "uptodate");
  });

  test("série nunca começada → 'never'", async () => {
    const { analyzer } = setup({
      watchlist: [series("A")],
      seasons: { A: [{ id: "A1", season_sequence_number: 1 }] },
      episodes: { A1: [episode("a1", 1)] },
      playheads: {},
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.status, "never");
  });

  test("ter visto qualquer versão de áudio conta como visto", async () => {
    const v = (n) => [
      { guid: `j${n}`, audio_locale: "ja-JP", original: true },
      { guid: `p${n}`, audio_locale: "pt-BR", original: false },
    ];
    const { analyzer } = setup({
      watchlist: [series("A")],
      seasons: { A: [{ id: "A1", season_sequence_number: 1 }] },
      episodes: { A1: [episode("j1", 1, { versions: v(1) }), episode("j2", 2, { versions: v(2) })] },
      playheads: { p1: playhead("p1", FULL, true) },
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.deepEqual(ids(r), ["j2"]);
  });
});

describe("temporadas", () => {
  test("volta para a temporada anterior quando a mais nova ainda não foi tocada", async () => {
    const { analyzer, calls } = setup({
      watchlist: [series("A")],
      seasons: {
        A: [
          { id: "S2", season_sequence_number: 2, season_number: 2 },
          { id: "S1", season_sequence_number: 1, season_number: 1 },
        ],
      },
      episodes: {
        S1: [episode("s1e1", 1), episode("s1e2", 2)],
        S2: [episode("s2e1", 1, { season: 2 }), episode("s2e2", 2, { season: 2 })],
      },
      playheads: { s1e1: playhead("s1e1", FULL, true), s1e2: playhead("s1e2", FULL, true) },
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.deepEqual(ids(r), ["s2e1", "s2e2"]);
    assert.equal(r.pending[0].season, 2);
    // pediu primeiro a temporada mais nova
    const eps = calls.filter((c) => c[0] === "episodes").map((c) => c[1]);
    assert.deepEqual(eps, ["S2", "S1"]);
  });

  test("não varre temporadas antigas se a mais nova já tem atividade", async () => {
    const { analyzer, calls } = setup({
      watchlist: [series("A")],
      seasons: { A: [{ id: "S1", season_sequence_number: 1 }, { id: "S2", season_sequence_number: 2 }] },
      episodes: { S1: [episode("x", 1)], S2: [episode("y1", 1), episode("y2", 2)] },
      playheads: { y1: playhead("y1", FULL, true) },
    });
    await analyzer.run({ settings: settings() });
    assert.deepEqual(
      calls.filter((c) => c[0] === "episodes").map((c) => c[1]),
      ["S2"]
    );
  });

  test("temporadas duplicadas por dublagem são contadas uma vez só", async () => {
    const versions = [
      { guid: "S1", audio_locale: "ja-JP", original: true },
      { guid: "S1-PT", audio_locale: "pt-BR", original: false },
    ];
    const { analyzer, calls } = setup({
      watchlist: [series("A")],
      seasons: {
        A: [
          { id: "S1", season_sequence_number: 1, versions },
          { id: "S1-PT", season_sequence_number: 1, versions },
        ],
      },
      episodes: { S1: [episode("e1", 1)], "S1-PT": [episode("e1pt", 1)] },
      playheads: {},
    });
    await analyzer.run({ settings: settings() });
    assert.deepEqual(
      calls.filter((c) => c[0] === "episodes").map((c) => c[1]),
      ["S1"]
    );
  });
});

describe("modo de áudio (legendado / dublado)", () => {
  // Original: eps 1–4 lançados. Dublagem pt-BR: 1–2 lançados, 3 agendado.
  // Usuário viu o 1 legendado e o 2 dublado.
  function dubDb() {
    const now = Date.now();
    const v = (n) => [
      { guid: `j${n}`, audio_locale: "ja-JP", original: true },
      { guid: `p${n}`, audio_locale: "pt-BR", original: false },
    ];
    return {
      watchlist: [series("S")],
      seasons: {
        S: [
          {
            id: "SJ",
            season_sequence_number: 1,
            audio_locale: "ja-JP",
            versions: [
              { guid: "SJ", audio_locale: "ja-JP", original: true },
              { guid: "SP", audio_locale: "pt-BR", original: false },
            ],
          },
        ],
      },
      episodes: {
        SJ: [1, 2, 3, 4].map((n) => episode(`j${n}`, n, { versions: v(n) })),
        SP: [
          episode("p1", 1, { audio: "pt-BR", versions: v(1) }),
          episode("p2", 2, { audio: "pt-BR", versions: v(2) }),
          episode("p3", 3, { audio: "pt-BR", versions: v(3), availableAt: now + 3 * DAY }),
        ],
      },
      playheads: { j1: playhead("j1", FULL, true), p2: playhead("p2", FULL, true) },
    };
  }

  test("legendado: avisa os episódios lançados no áudio original", async () => {
    const { analyzer } = setup(dubDb());
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "sub" }) });
    assert.equal(r.status, "pending");
    assert.deepEqual(ids(r), ["j3", "j4"]);
  });

  test("dublado: só avisa quando a dublagem sai; conta os que esperam dublagem", async () => {
    const { analyzer } = setup(dubDb());
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub" }) });
    assert.equal(r.status, "uptodate");
    assert.deepEqual(ids(r), []);
    assert.equal(r.waitingDub, 2); // eps 3 e 4 já saíram legendados
  });

  test("dublado: avisa assim que o episódio dublado é liberado, com link da versão dublada", async () => {
    const db = dubDb();
    db.episodes.SP[2].availability_starts = new Date(Date.now() - DAY).toISOString();
    const { analyzer } = setup(db);
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub" }) });
    assert.deepEqual(ids(r), ["p3"]);
    assert.equal(r.waitingDub, 1); // o 4 continua só legendado
  });

  test("dublado em idioma que a série não tem: nada pendente, marca a falta de dublagem", async () => {
    const { analyzer } = setup(dubDb());
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub", dubLang: "fr-FR" }) });
    assert.equal(r.status, "uptodate");
    assert.equal(r.dubMissing, true);
    assert.equal(r.waitingDub, 2);
  });

  test("qualquer áudio: não aponta para uma dublagem ainda não lançada", async () => {
    const { analyzer } = setup(dubDb());
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "auto" }) });
    assert.deepEqual(ids(r), ["j3", "j4"]);
  });

  test("o modo por série tem prioridade sobre o padrão", async () => {
    const { analyzer } = setup(dubDb());
    const [r] = await analyzer.run({
      settings: settings({ defaultMode: "sub", seriesModes: { S: "dub" } }),
    });
    assert.equal(r.mode, "dub");
    assert.equal(r.status, "uptodate");
  });
});

describe("Fila, cache e erros", () => {
  test("inclui filmes, aceita painel de episódio e remove séries repetidas", async () => {
    const { analyzer } = setup({
      watchlist: [
        { panel: { type: "movie_listing", id: "M" } },
        {
          panel: {
            type: "episode",
            id: "a1",
            episode_metadata: { series_id: "A", series_title: "Série A", series_slug_title: "a" },
          },
        },
        series("A"),
      ],
      seasons: { A: [{ id: "A1", season_sequence_number: 1 }] },
      episodes: { A1: [episode("a1", 1)] },
      playheads: {},
    });
    const results = await analyzer.run({ settings: settings() });
    assert.equal(results.length, 2);
    const movie = results.find((r) => r.seriesId === "M");
    assert.equal(movie.kind, "movie");
    assert.equal(movie.status, "never");
    const a = results.find((r) => r.seriesId === "A");
    assert.equal(a.title, "Série A");
  });

  test("reaproveita o cache e só refaz quando o modo muda ou com force", async () => {
    const db = {
      watchlist: [series("A")],
      seasons: { A: [{ id: "A1", season_sequence_number: 1 }] },
      episodes: { A1: [episode("a1", 1), episode("a2", 2)] },
      playheads: { a1: playhead("a1", FULL, true) },
    };
    const { analyzer, calls } = setup(db);
    const count = () => calls.filter((c) => c[0] === "seasons").length;

    await analyzer.run({ settings: settings() });
    assert.equal(count(), 1);
    await analyzer.run({ settings: settings() });
    assert.equal(count(), 1, "segunda execução deveria vir do cache");
    await analyzer.run({ settings: settings({ defaultMode: "sub" }) });
    assert.equal(count(), 2, "mudar o modo invalida o cache");
    await analyzer.run({ settings: settings({ defaultMode: "sub" }), force: true });
    assert.equal(count(), 3, "force ignora o cache");
  });

  test("erro em uma série não derruba as outras e não vai para o cache", async () => {
    const { analyzer } = setup({
      watchlist: [series("OK"), series("RUIM")],
      seasons: { OK: [{ id: "K1", season_sequence_number: 1 }] },
      episodes: { K1: [episode("k1", 1), episode("k2", 2)] },
      playheads: { k1: playhead("k1", FULL, true) },
      fail: ["RUIM"],
    });
    const results = await analyzer.run({ settings: settings() });
    const byId = Object.fromEntries(results.map((r) => [r.seriesId, r]));
    assert.equal(byId.OK.status, "pending");
    assert.equal(byId.RUIM.status, "error");
    assert.match(byId.RUIM.error, /HTTP 500/);
  });

  test("informa o progresso série a série", async () => {
    const { analyzer } = setup({
      watchlist: [series("A"), series("B")],
      seasons: {},
      episodes: {},
      playheads: {},
    });
    const seen = [];
    await analyzer.run({ settings: settings(), onProgress: (d, t) => seen.push(`${d}/${t}`) });
    assert.deepEqual(seen, ["0/2", "1/2", "2/2"]);
  });

  test("runOne reanalisa uma série com o novo modo", async () => {
    const { analyzer } = setup({
      watchlist: [series("A")],
      seasons: { A: [{ id: "A1", season_sequence_number: 1 }] },
      episodes: { A1: [episode("a1", 1), episode("a2", 2)] },
      playheads: { a1: playhead("a1", FULL, true) },
    });
    const [first] = await analyzer.run({ settings: settings() });
    const again = await analyzer.runOne(first, settings({ seriesModes: { A: "sub" } }));
    assert.equal(again.mode, "sub");
    assert.deepEqual(ids(again), ["a2"]);
  });
});

describe("paralelismo", () => {
  function setupWithDelay(seriesCount, delayMs = 15) {
    const stats = { inFlight: 0, max: 0, order: [] };
    const CRApi = {
      getAccountId: async () => "conta-1",
      watchlist: async () => Array.from({ length: seriesCount }, (_, i) => series(`S${i}`)),
      seasons: async (id) => {
        stats.inFlight++;
        stats.max = Math.max(stats.max, stats.inFlight);
        stats.order.push(id);
        await new Promise((r) => setTimeout(r, delayMs));
        stats.inFlight--;
        return [{ id: `T-${id}`, season_sequence_number: 1 }];
      },
      episodes: async (id) => [episode(`e-${id}`, 1)],
      playheads: async () => new Map(),
    };
    const quiet = { ...console, warn: () => {} };
    const ctx = load(["src/analyzer.js"], { browser: fakeBrowser(), CRApi, console: quiet });
    return { analyzer: ctx.CRAnalyzer, stats };
  }

  test("respeita a quantidade de séries simultâneas configurada", async () => {
    for (const n of [1, 3, 8]) {
      const { analyzer, stats } = setupWithDelay(12);
      const results = await analyzer.run({ settings: settings({ concurrency: n }) });
      assert.equal(stats.max, n, `com concurrency=${n}`);
      assert.equal(results.length, 12);
    }
  });

  test("sem configuração usa o padrão (4)", async () => {
    const { analyzer, stats } = setupWithDelay(10);
    await analyzer.run({ settings: settings() });
    assert.equal(stats.max, 4);
  });

  test("nunca abre mais consultas do que séries existentes", async () => {
    const { analyzer, stats } = setupWithDelay(2);
    await analyzer.run({ settings: settings({ concurrency: 16 }) });
    assert.equal(stats.max, 2);
  });

  test("em paralelo é mais rápido que em série", async () => {
    const time = async (n) => {
      const { analyzer } = setupWithDelay(8, 25);
      const t0 = Date.now();
      await analyzer.run({ settings: settings({ concurrency: n }) });
      return Date.now() - t0;
    };
    const serial = await time(1);
    const parallel = await time(8);
    assert.ok(parallel * 3 < serial, `paralelo ${parallel}ms vs serial ${serial}ms`);
  });

  test("resultados saem na ordem da Fila, mesmo terminando fora de ordem", async () => {
    const CRApi = {
      getAccountId: async () => "conta-1",
      watchlist: async () => [series("LENTA"), series("RAPIDA")],
      seasons: async (id) => {
        await new Promise((r) => setTimeout(r, id === "LENTA" ? 40 : 1));
        return [];
      },
      episodes: async () => [],
      playheads: async () => new Map(),
    };
    const ctx = load(["src/analyzer.js"], { browser: fakeBrowser(), CRApi });
    const results = await ctx.CRAnalyzer.run({ settings: settings({ concurrency: 2 }) });
    assert.deepEqual(plain(results.map((r) => r.seriesId)), ["LENTA", "RAPIDA"]);
  });

  test("tamanho do lote de playheads: valores ajustados à faixa", () => {
    const { analyzer } = setup({ watchlist: [], seasons: {}, episodes: {}, playheads: {} });
    const b = (v) => analyzer.playheadBatchFrom({ playheadBatch: v });
    assert.equal(b(undefined), 100);
    assert.equal(b(""), 100);
    assert.equal(b("abc"), 100);
    assert.equal(b(1), 10);
    assert.equal(b(1000), 300);
    assert.equal(b(300), 300);
    assert.equal(b("150"), 150);
    assert.equal(b(99.6), 100);
    assert.equal(analyzer.playheadBatchFrom(undefined), 100);
  });

  test("a verificação repassa o tamanho do lote configurado para a API", async () => {
    const sizes = [];
    const pages = [];
    const hist = [];
    const CRApi = {
      getAccountId: async () => "conta-1",
      watchlist: async (_locale, opts) => (pages.push(opts.pageSize), []),
      watchHistory: async (_locale, opts) => (hist.push(opts.pageSize), { entries: [], complete: true }),
      seasons: async () => [],
      episodes: async () => [],
      playheads: async () => new Map(),
      setPlayheadBatchSize: (n) => sizes.push(n),
    };
    const ctx = load(["src/analyzer.js"], { browser: fakeBrowser(), CRApi });
    await ctx.CRAnalyzer.run({ settings: settings({ playheadBatch: 150 }) });
    await ctx.CRAnalyzer.run({ settings: settings() });
    assert.deepEqual(sizes, [150, 100]);
    assert.deepEqual(pages, [150, 100], "a Fila usa o mesmo tamanho de lote");
    assert.deepEqual(hist, [150, 100], "o histórico também");
  });

  test("valores inválidos da configuração são ajustados", () => {
    const { analyzer } = setup({ watchlist: [], seasons: {}, episodes: {}, playheads: {} });
    const c = (v) => analyzer.concurrencyFrom({ concurrency: v });
    assert.equal(c(0), 1);
    assert.equal(c(-5), 1);
    assert.equal(c(100), 32);
    assert.equal(c(32), 32);
    assert.equal(c(20), 20);
    assert.equal(c("6"), 6);
    assert.equal(c(2.6), 3);
    assert.equal(c("abc"), 4);
    assert.equal(c(""), 4);
    assert.equal(c(undefined), 4);
    assert.equal(analyzer.concurrencyFrom(undefined), 4);
  });
});

describe("dados reais: Saga of Tanya the Evil, 2ª temporada", () => {
  // Resposta real da lista pt-BR: episódios 1–11 dublados, 12 só no áudio original.
  const fixture = require("./fixtures/tanya-s2-ptbr-episodes.json").data;
  const SEASON = {
    id: "GS00380130JAJP",
    season_number: 4,
    season_sequence_number: 4,
    versions: [
      { guid: "GS00380130JAJP", audio_locale: "ja-JP", original: true },
      { guid: "GS00380130PTBR", audio_locale: "pt-BR", original: false },
    ],
  };
  // Lista no áudio original, derivada das versões de cada episódio da resposta real.
  const japanese = () =>
    fixture.map((e) => {
      const ja = e.versions.find((v) => v.audio_locale === "ja-JP");
      return { ...e, id: ja.guid, audio_locale: "ja-JP", availability_starts: e.episode_air_date };
    });
  const watchedDubbed = (n) =>
    Object.fromEntries(
      fixture.slice(0, n).map((e) => {
        const pt = e.versions.find((v) => v.audio_locale === "pt-BR");
        return [pt.guid, playhead(pt.guid, 1500, true)];
      })
    );
  const db = (episodesPt) => ({
    watchlist: [series("GR9P57W96")],
    seasons: { GR9P57W96: [SEASON] },
    episodes: { GS00380130PTBR: episodesPt, GS00380130JAJP: japanese() },
    playheads: watchedDubbed(11),
  });

  test("a resposta real tem o episódio 12 em ja-JP dentro da lista pt-BR", () => {
    const e12 = fixture.find((e) => e.episode === "12");
    assert.equal(e12.audio_locale, "ja-JP");
    assert.ok(fixture.filter((e) => e.episode !== "12").every((e) => e.audio_locale === "pt-BR"));
  });

  test("dublado, vistos 1–11: NÃO anuncia o 12 (o bug relatado) e o mostra aguardando dublagem", async () => {
    const { analyzer } = setup(db(fixture));
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub" }) });
    assert.equal(r.status, "uptodate");
    assert.deepEqual(ids(r), []);
    assert.equal(r.waitingDub, 1);
  });

  test("dublado: quando a dublagem do 12 sai, anuncia com o link da versão pt-BR", async () => {
    const dubbed12 = fixture.map((e) =>
      e.episode === "12"
        ? {
            ...e,
            id: "GE00380142PTBR",
            audio_locale: "pt-BR",
            availability_starts: new Date(Date.now() - DAY).toISOString(),
            versions: [...e.versions, { guid: "GE00380142PTBR", audio_locale: "pt-BR", original: false }],
          }
        : e
    );
    const { analyzer } = setup(db(dubbed12));
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub" }) });
    assert.deepEqual(ids(r), ["GE00380142PTBR"]);
    assert.equal(r.waitingDub, 0);
  });

  test("legendado, vistos 1–11 dublados: anuncia o 12 no áudio original", async () => {
    const { analyzer } = setup(db(fixture));
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "sub" }) });
    assert.deepEqual(ids(r), ["GE00380142JAJP"]);
  });
});

test("dublado pt-BR: episódio que a lista traz com dublagem em outro idioma não conta", async () => {
  // Caso parecido com o de You and I Are Polar Opposites: o E12 só tem dublagem em inglês.
  const v = (n) => [
    { guid: `j${n}`, audio_locale: "ja-JP", original: true },
    { guid: `p${n}`, audio_locale: "pt-BR" },
    { guid: `e${n}`, audio_locale: "en-US" },
  ];
  const season = {
    id: "SJ",
    season_sequence_number: 1,
    versions: [
      { guid: "SJ", audio_locale: "ja-JP", original: true },
      { guid: "SP", audio_locale: "pt-BR" },
    ],
  };
  const { analyzer } = setup({
    watchlist: [series("P")],
    seasons: { P: [season] },
    episodes: {
      SP: [
        episode("p1", 1, { audio: "pt-BR", versions: v(1) }),
        episode("e2", 2, { audio: "en-US", versions: v(2) }),
      ],
      SJ: [episode("j1", 1, { versions: v(1) }), episode("j2", 2, { versions: v(2) })],
    },
    playheads: { p1: playhead("p1", FULL, true) },
  });
  const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub" }) });
  assert.equal(r.status, "uptodate");
  assert.equal(r.waitingDub, 1);
});

test("dublado: decide pelo audio_locale do episódio e ignora is_dubbed", async () => {
  // is_dubbed não é confiável: aqui ele contradiz o áudio real nos dois sentidos.
  const v = (n) => [
    { guid: `j${n}`, audio_locale: "ja-JP", original: true },
    { guid: `p${n}`, audio_locale: "pt-BR" },
  ];
  const season = {
    id: "SJ",
    season_sequence_number: 1,
    versions: [
      { guid: "SJ", audio_locale: "ja-JP", original: true },
      { guid: "SP", audio_locale: "pt-BR" },
    ],
  };
  const mentira = (ep, isDubbed) => ({ ...ep, is_dubbed: isDubbed });
  const { analyzer } = setup({
    watchlist: [series("X")],
    seasons: { X: [season] },
    episodes: {
      SP: [
        mentira(episode("p1", 1, { audio: "pt-BR", versions: v(1) }), false), // dublado, diz que não
        mentira(episode("p2", 2, { audio: "pt-BR", versions: v(2) }), false), // dublado, diz que não
        mentira(episode("j3", 3, { audio: "ja-JP", versions: v(3) }), true), // original, diz que sim
      ],
      SJ: [1, 2, 3].map((n) => episode(`j${n}`, n, { versions: v(n) })),
    },
    playheads: { p1: playhead("p1", FULL, true) },
  });
  const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub" }) });
  assert.deepEqual(ids(r), ["p2"]); // o 2 está em pt-BR, apesar de is_dubbed=false
  assert.equal(r.waitingDub, 1); // o 3 está em ja-JP, apesar de is_dubbed=true
});

describe("registros de reprodução curtos (dados reais: No Longer Allowed in Another World)", () => {
  const eps = require("./fixtures/no-longer-allowed-s1-episodes.json").data;
  const season = {
    id: "G6WEC315N",
    season_sequence_number: 1,
    versions: [{ guid: "G6WEC315N", audio_locale: "ja-JP", original: true }],
  };
  const run = async (playheads, mode = "sub") => {
    const { analyzer } = setup({
      watchlist: [series("GXJHM3G7X")],
      seasons: { GXJHM3G7X: [season] },
      episodes: { G6WEC315N: eps },
      playheads,
    });
    const [r] = await analyzer.run({ settings: settings({ defaultMode: mode }) });
    return r;
  };
  const e = (n) => eps[n - 1].id;

  test("registro com 0 s (só abriu a página) não conta como começado", async () => {
    const r = await run({ [e(1)]: playhead(e(1), 0, false) });
    assert.equal(r.status, "never");
  });

  test("o registro real enviado pelo usuário (playhead 0 no E1) não conta como começado", async () => {
    // Resposta real de /content/v2/{conta}/playheads para esta série.
    const real = {
      total: 1,
      data: [{ playhead: 0, content_id: "GG1U2J9Q1", fully_watched: false, last_modified: "2026-10-13T19:56:06Z" }],
    };
    const r = await run(Object.fromEntries(real.data.map((p) => [p.content_id, p])));
    assert.equal(r.status, "never");
    assert.deepEqual(ids(r), []);
  });

  test("alguns segundos de reprodução automática também não", async () => {
    const r = await run({ [e(1)]: playhead(e(1), 15, false), [e(3)]: playhead(e(3), 59, false) });
    assert.equal(r.status, "never");
  });

  test("a partir de 1 minuto conta como começado", async () => {
    const r = await run({ [e(1)]: playhead(e(1), 60, false) });
    assert.equal(r.status, "pending");
    assert.equal(r.pending[0].id, e(1));
    assert.equal(r.pending[0].inProgress, true);
  });

  test("fully_watched conta mesmo com playhead 0", async () => {
    const r = await run({ [e(1)]: playhead(e(1), 0, true) });
    assert.equal(plain(r.pending.map((p) => p.number))[0], "2");
  });

  test("registro curto num episódio adiante não pula os anteriores", async () => {
    // Viu de verdade o 1; abriu o 8 por engano por 5 s.
    const r = await run({ [e(1)]: playhead(e(1), 1420, true), [e(8)]: playhead(e(8), 5, false) });
    assert.equal(plain(r.pending.map((p) => p.number)).join(","), "2,3,4,5,6,7,8,9,10,11,12");
  });

  test("is_dubbed é true mas não há pt-BR: modo dublado não anuncia nada", async () => {
    assert.ok(eps.every((x) => x.is_dubbed === true));
    const r = await run({ [e(1)]: playhead(e(1), 1420, true) }, "dub");
    assert.deepEqual(ids(r), []);
  });
});

describe("sem dublagem × aguardando dublagem", () => {
  test("No Longer Allowed (sem nenhum episódio pt-BR): noDub, com os legendados contados", async () => {
    const eps = require("./fixtures/no-longer-allowed-s1-episodes.json").data;
    const season = {
      id: "G6WEC315N",
      season_sequence_number: 1,
      versions: [{ guid: "G6WEC315N", audio_locale: "ja-JP", original: true }],
    };
    const { analyzer } = setup({
      watchlist: [series("GXJHM3G7X")],
      seasons: { GXJHM3G7X: [season] },
      episodes: { G6WEC315N: eps },
      playheads: Object.fromEntries(eps.slice(0, 5).map((e) => [e.id, playhead(e.id, 1420, true)])),
    });
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub" }) });
    assert.equal(r.status, "uptodate");
    assert.equal(r.noDub, true);
    assert.equal(r.waitingDub, 7);
  });

  test("Tanya T2 (dublagem pt-BR existe, falta o 12): aguardando, não 'sem dublagem'", async () => {
    const fixture = require("./fixtures/tanya-s2-ptbr-episodes.json").data;
    const season = {
      id: "GS00380130JAJP",
      season_sequence_number: 4,
      versions: [
        { guid: "GS00380130JAJP", audio_locale: "ja-JP", original: true },
        { guid: "GS00380130PTBR", audio_locale: "pt-BR", original: false },
      ],
    };
    const ph = Object.fromEntries(
      fixture.slice(0, 11).map((e) => {
        const pt = e.versions.find((v) => v.audio_locale === "pt-BR");
        return [pt.guid, playhead(pt.guid, 1500, true)];
      })
    );
    const { analyzer } = setup({
      watchlist: [series("GR9P57W96")],
      seasons: { GR9P57W96: [season] },
      episodes: { GS00380130PTBR: fixture, GS00380130JAJP: [] },
      playheads: ph,
    });
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub" }) });
    assert.equal(r.noDub, false);
    assert.equal(r.waitingDub, 1);
  });

  test("lista dublada que só traz episódios no áudio original também é 'sem dublagem'", async () => {
    const season = {
      id: "SJ",
      season_sequence_number: 1,
      versions: [
        { guid: "SJ", audio_locale: "ja-JP", original: true },
        { guid: "SP", audio_locale: "pt-BR" },
      ],
    };
    const { analyzer } = setup({
      watchlist: [series("Z")],
      seasons: { Z: [season] },
      episodes: { SP: [episode("j1", 1), episode("j2", 2)], SJ: [episode("j1", 1), episode("j2", 2)] },
      playheads: { j1: playhead("j1", FULL, true) },
    });
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub" }) });
    assert.equal(r.noDub, true);
  });

  test("fora do modo dublado, noDub é sempre falso", async () => {
    const eps = require("./fixtures/no-longer-allowed-s1-episodes.json").data;
    const { analyzer } = setup({
      watchlist: [series("GXJHM3G7X")],
      seasons: { GXJHM3G7X: [{ id: "G6WEC315N", season_sequence_number: 1 }] },
      episodes: { G6WEC315N: eps },
      playheads: { [eps[0].id]: playhead(eps[0].id, 1420, true) },
    });
    for (const mode of ["sub", "auto"]) {
      const [r] = await analyzer.run({ settings: settings({ defaultMode: mode }), force: true });
      assert.equal(r.noDub, false, mode);
    }
  });
});

describe("legenda no modo legendado", () => {
  const withSubs = (ep, subs) => ({ ...ep, subtitle_locales: subs });
  const db = (eps, ph) => ({
    watchlist: [series("L")],
    seasons: { L: [{ id: "T", season_sequence_number: 1 }] },
    episodes: { T: eps },
    playheads: ph,
  });

  test("simulcast sem legenda pt-BR ainda: não anuncia, conta como aguardando legenda", async () => {
    const { analyzer } = setup(
      db(
        [
          withSubs(episode("e1", 1), ["en-US", "pt-BR"]),
          withSubs(episode("e2", 2), ["en-US", "pt-BR"]),
          withSubs(episode("e3", 3), ["en-US"]), // legenda pt-BR ainda não saiu
        ],
        { e1: playhead("e1", FULL, true) }
      )
    );
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "sub" }) });
    assert.deepEqual(ids(r), ["e2"]);
    assert.equal(r.waitingSub, 1);
  });

  test("respeita o idioma de legenda configurado", async () => {
    const { analyzer } = setup(
      db([withSubs(episode("e1", 1), ["en-US"]), withSubs(episode("e2", 2), ["en-US"])], {
        e1: playhead("e1", FULL, true),
      })
    );
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "sub", subLang: "en-US" }) });
    assert.deepEqual(ids(r), ["e2"]);
    assert.equal(r.waitingSub, 0);
  });

  test("sem a lista de legendas na resposta, anuncia (não esconde sem motivo)", async () => {
    const { analyzer } = setup(db([episode("e1", 1), episode("e2", 2)], { e1: playhead("e1", FULL, true) }));
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "sub" }) });
    assert.deepEqual(ids(r), ["e2"]);
  });

  test("lista de legendas vazia conta como sem legenda", async () => {
    const { analyzer } = setup(
      db([withSubs(episode("e1", 1), ["pt-BR"]), withSubs(episode("e2", 2), [])], { e1: playhead("e1", FULL, true) })
    );
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "sub" }) });
    assert.deepEqual(ids(r), []);
    assert.equal(r.waitingSub, 1);
  });

  test("episódio com áudio no próprio idioma da legenda não precisa de legenda", async () => {
    const { analyzer } = setup(
      db([withSubs(episode("e1", 1, { audio: "pt-BR" }), []), withSubs(episode("e2", 2, { audio: "pt-BR" }), [])], {
        e1: playhead("e1", FULL, true),
      })
    );
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "sub" }) });
    assert.deepEqual(ids(r), ["e2"]);
  });

  test("modo qualquer áudio não exige legenda", async () => {
    for (const mode of ["auto"]) {
      const { analyzer } = setup(
        db([withSubs(episode("e1", 1), ["pt-BR"]), withSubs(episode("e2", 2), ["en-US"])], {
          e1: playhead("e1", FULL, true),
        })
      );
      const [r] = await analyzer.run({ settings: settings({ defaultMode: mode }) });
      assert.deepEqual(ids(r), ["e2"], mode);
      assert.equal(r.waitingSub, 0, mode);
    }
  });

  test("trocar o idioma da legenda invalida o cache do modo legendado", async () => {
    const { analyzer, calls } = setup(db([withSubs(episode("e1", 1), ["pt-BR"])], {}));
    const count = () => calls.filter((c) => c[0] === "seasons").length;
    await analyzer.run({ settings: settings({ defaultMode: "sub" }) });
    await analyzer.run({ settings: settings({ defaultMode: "sub" }) });
    assert.equal(count(), 1);
    await analyzer.run({ settings: settings({ defaultMode: "sub", subLang: "es-419" }) });
    assert.equal(count(), 2);
  });
});

describe("especiais e recapitulações", () => {
  const db = (eps, ph, seasons) => ({
    watchlist: [series("X")],
    seasons: { X: seasons || [{ id: "T", season_sequence_number: 1 }] },
    episodes: { T: eps },
    playheads: ph,
  });

  test("classifica episódios extras pela numeração e pelo título", () => {
    const { analyzer } = setup(db([], {}));
    const k = (ep, season) => analyzer.extraKind(ep, season);
    assert.equal(k({ episode: "5", episode_number: 5, title: "A batalha" }), null);
    assert.equal(k({ episode: "13.5", episode_number: null, title: "Bônus" }), "especial");
    assert.equal(k({ episode: "SP", episode_number: null, title: "Especial de verão" }), "especial");
    assert.equal(k({ episode: "", episode_number: null, title: "Sem número" }), "especial");
    assert.equal(k({ episode: "7", episode_number: 7, title: "Recap: até aqui" }), "recap");
    assert.equal(k({ episode: "7", episode_number: 7, title: "Recapitulação" }), "recap");
    assert.equal(k({ episode: "3", episode_number: 3, title: "Um dia especial" }), null, "palavra 'especial' no título não basta");
    assert.equal(k({ episode: "1", episode_number: 1, title: "Início" }, { title: "Specials" }), "especial");
    assert.equal(k({ episode: "1", episode_number: 1, title: "Início" }, { title: "OVA", season_number: 2 }), "especial");
  });

  test("extras aparecem marcados e não entram na contagem do ícone", async () => {
    const e135 = { ...episode("e13h", 13.5), episode: "13.5", episode_number: null };
    const { analyzer } = setup(
      db([episode("e12", 12), episode("e13", 13), e135, episode("e14", 14)], { e12: playhead("e12", FULL, true) })
    );
    const [r] = await analyzer.run({ settings: settings() });
    assert.deepEqual(ids(r), ["e13", "e13h", "e14"]);
    assert.equal(r.pending[1].extra, "especial");
    const { CRChecker } = load(["src/checker.js"], { browser: fakeBrowser() });
    assert.equal(CRChecker.summarize([r]).episodes, 2);
  });

  test("com 'mostrar especiais' desligado, os extras somem", async () => {
    const recap = { ...episode("r", 13), title: "Recap" };
    const { analyzer } = setup(db([episode("e12", 12), recap, episode("e14", 14)], { e12: playhead("e12", FULL, true) }));
    const [r] = await analyzer.run({ settings: settings({ showExtras: false }) });
    assert.deepEqual(ids(r), ["e14"]);
  });

  test("temporada de especiais não prende a busca pela temporada atual", async () => {
    const { analyzer } = setup({
      watchlist: [series("X")],
      seasons: {
        X: [
          { id: "S1", season_sequence_number: 1, season_number: 1, title: "Temporada 1" },
          { id: "S2", season_sequence_number: 2, season_number: 2, title: "Temporada 2" },
          { id: "SP", season_sequence_number: 3, season_number: 3, title: "Specials" },
        ],
      },
      episodes: {
        S1: [episode("a1", 1)],
        S2: [episode("b1", 1, { season: 2 }), episode("b2", 2, { season: 2 })],
        SP: [episode("sp1", 1, { season: 3 })],
      },
      playheads: { b1: playhead("b1", FULL, true) },
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.deepEqual(ids(r), ["b2"]);
  });

  test("só extras pendentes: card existe, mas a contagem é zero", async () => {
    const recap = { ...episode("r", 3), title: "Resumo da temporada" };
    const { analyzer } = setup(db([episode("e1", 1), episode("e2", 2), recap], {
      e1: playhead("e1", FULL, true),
      e2: playhead("e2", FULL, true),
    }));
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.status, "pending");
    assert.deepEqual(ids(r), ["r"]);
    const { CRChecker } = load(["src/checker.js"], { browser: fakeBrowser() });
    assert.equal(CRChecker.summarize([r]).episodes, 0);
  });
});

test("cache separado por perfil: trocar de perfil recalcula", async () => {
  let profile = "p1";
  let seasonsCalls = 0;
  const CRApi = {
    getAccountId: async () => "conta",
    getProfileId: async () => profile,
    watchlist: async () => [series("A")],
    seasons: async () => (seasonsCalls++, [{ id: "T", season_sequence_number: 1 }]),
    episodes: async () => [episode("e1", 1)],
    playheads: async () => new Map(),
  };
  const ctx = load(["src/analyzer.js"], { browser: fakeBrowser(), CRApi });
  assert.equal(await ctx.CRAnalyzer.cacheScope(), "conta:p1");
  await ctx.CRAnalyzer.run({ settings: settings() });
  await ctx.CRAnalyzer.run({ settings: settings() });
  assert.equal(seasonsCalls, 1, "mesmo perfil: do cache");
  profile = "p2";
  await ctx.CRAnalyzer.run({ settings: settings() });
  assert.equal(seasonsCalls, 2, "outro perfil: recalcula");
});

describe("episódios pulados", () => {
  const db = () => ({
    watchlist: [series("X")],
    seasons: { X: [{ id: "T", season_sequence_number: 1 }] },
    episodes: {
      T: [
        episode("e1", 1),
        episode("e2", 2),
        { ...episode("e3", 3), title: "Recap" },
        episode("e4", 4),
        episode("e5", 5),
        episode("e6", 6),
      ],
    },
    // viu 1 e 4; pulou 2 (e o recap 3); 5 e 6 são novos
    playheads: { e1: playhead("e1", FULL, true), e4: playhead("e4", FULL, true) },
  });

  test("desligado (padrão): só os novos depois do último visto", async () => {
    const { analyzer } = setup(db());
    const [r] = await analyzer.run({ settings: settings() });
    assert.deepEqual(ids(r), ["e5", "e6"]);
  });

  test("ligado: inclui os pulados antes, marcados, sem os extras", async () => {
    const { analyzer } = setup(db());
    const [r] = await analyzer.run({ settings: settings({ showSkipped: true }) });
    assert.deepEqual(ids(r), ["e2", "e5", "e6"]);
    assert.deepEqual(plain(r.pending.map((p) => p.skipped)), [true, false, false]);
  });

  test("pulados não entram na contagem do ícone", async () => {
    const { analyzer } = setup(db());
    const [r] = await analyzer.run({ settings: settings({ showSkipped: true }) });
    const { CRChecker } = load(["src/checker.js"], { browser: fakeBrowser() });
    assert.equal(CRChecker.summarize([r]).episodes, 2);
  });

  test("ligar/desligar a opção invalida o cache", async () => {
    const { analyzer, calls } = setup(db());
    const count = () => calls.filter((c) => c[0] === "seasons").length;
    await analyzer.run({ settings: settings() });
    await analyzer.run({ settings: settings({ showSkipped: true }) });
    assert.equal(count(), 2);
  });
});

describe("limite de 'começado' configurável", () => {
  const db = (secs) => ({
    watchlist: [series("X")],
    seasons: { X: [{ id: "T", season_sequence_number: 1 }] },
    episodes: { T: [episode("e1", 1), episode("e2", 2)] },
    playheads: { e1: playhead("e1", secs, false) },
  });

  test("com 0, qualquer registro conta (até 0 s)", async () => {
    const { analyzer } = setup(db(0));
    const [r] = await analyzer.run({ settings: settings({ minStartedSeconds: 0 }) });
    assert.equal(r.status, "pending");
  });

  test("com 300, 2 minutos não contam", async () => {
    const { analyzer } = setup(db(120));
    const [r] = await analyzer.run({ settings: settings({ minStartedSeconds: 300 }) });
    assert.equal(r.status, "never");
  });

  test("padrão continua 60", async () => {
    const { analyzer } = setup(db(59));
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.status, "never");
    const { analyzer: a2 } = setup(db(60));
    const [r2] = await a2.run({ settings: settings() });
    assert.equal(r2.status, "pending");
  });

  test("valores inválidos são ajustados", () => {
    const { analyzer } = setup(db(0));
    const m = (v) => analyzer.minStartedFrom({ minStartedSeconds: v });
    assert.equal(m(-10), 0);
    assert.equal(m(9999), 600);
    assert.equal(m("90"), 90);
    assert.equal(m(""), 60);
    assert.equal(m("abc"), 60);
    assert.equal(analyzer.minStartedFrom({}), 60);
  });

  test("mudar o limite invalida o cache", async () => {
    const { analyzer, calls } = setup(db(120));
    const count = () => calls.filter((c) => c[0] === "seasons").length;
    await analyzer.run({ settings: settings() });
    await analyzer.run({ settings: settings({ minStartedSeconds: 60 }) });
    assert.equal(count(), 1, "60 explícito = padrão");
    await analyzer.run({ settings: settings({ minStartedSeconds: 300 }) });
    assert.equal(count(), 2);
  });
});

describe("filmes da Fila", () => {
  const movieItem = (id, title) => ({ panel: { type: "movie_listing", id, title, slug_title: id.toLowerCase() } });
  const movie = (id, extra = {}) => ({
    id,
    title: extra.title || `Filme ${id}`,
    slug_title: id.toLowerCase(),
    duration_ms: 100 * 60 * 1000,
    availability_status: "available",
    premium_available_date: "2024-01-01T00:00:00Z",
    images: { thumbnail: [[{ source: `https://img/${id}.jpg`, width: 320 }]] },
    ...extra,
  });
  const listing = {
    id: "L-JA",
    versions: [
      { guid: "L-JA", audio_locale: "ja-JP", original: true },
      { guid: "L-PT", audio_locale: "pt-BR", original: false },
    ],
  };
  const db = (playheads, extra = {}) => ({
    watchlist: [movieItem("L-JA", "Um Filme")],
    seasons: {},
    episodes: {},
    movieListings: { "L-JA": listing },
    movies: { "L-JA": [movie("M-JA")], "L-PT": [movie("M-PT")] },
    playheads,
    ...extra,
  });

  test("não começado vai para 'never'", async () => {
    const { analyzer } = setup(db({}));
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.kind, "movie");
    assert.equal(r.status, "never");
  });

  test("visto dublado conta como visto no modo legendado (qualquer áudio vale)", async () => {
    const { analyzer } = setup(db({ "M-PT": playhead("M-PT", 6000, true) }));
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "sub" }) });
    assert.equal(r.status, "uptodate");
  });

  test("começado e não terminado: 'para assistir' com progresso", async () => {
    const { analyzer } = setup(db({ "M-JA": playhead("M-JA", 1800, false) }));
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "sub" }) });
    assert.equal(r.status, "pending");
    assert.equal(r.pending[0].id, "M-JA");
    assert.equal(r.pending[0].kind, "movie");
    assert.equal(r.pending[0].inProgress, true);
    assert.equal(r.pending[0].progress, 0.3);
  });

  test("modo dublado com versão pt-BR: link para o filme dublado", async () => {
    const { analyzer } = setup(db({ "M-JA": playhead("M-JA", 1800, false) }));
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub" }) });
    assert.equal(r.pending[0].id, "M-PT");
    assert.equal(r.noDub, false);
  });

  test("modo dublado sem versão no idioma: noDub, link no original", async () => {
    const onlyJa = { id: "L-JA", versions: [{ guid: "L-JA", audio_locale: "ja-JP", original: true }] };
    const { analyzer } = setup(db({ "M-JA": playhead("M-JA", 1800, false) }, { movieListings: { "L-JA": onlyJa } }));
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub" }) });
    assert.equal(r.noDub, true);
    assert.equal(r.pending[0].id, "M-JA");
  });

  test("filme em duas partes: viu a 1ª, aparece a 2ª", async () => {
    const { analyzer } = setup(
      db(
        { "P1-JA": playhead("P1-JA", 6000, true) },
        {
          movies: {
            "L-JA": [movie("P1-JA", { title: "Parte 1" }), movie("P2-JA", { title: "Parte 2" })],
            "L-PT": [movie("P1-PT"), movie("P2-PT")],
          },
        }
      )
    );
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "sub" }) });
    assert.deepEqual(ids(r), ["P2-JA"]);
    assert.equal(r.pending[0].inProgress, false);
  });

  test("registro curto (< limite) não conta como começado", async () => {
    const { analyzer } = setup(db({ "M-JA": playhead("M-JA", 10, false) }));
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.status, "never");
  });

  test("painel de filme avulso (type movie) vira o título dele", async () => {
    const { analyzer } = setup(
      db({}, { watchlist: [{ panel: { type: "movie", id: "M-JA", movie_metadata: { movie_listing_id: "L-JA", movie_listing_title: "Um Filme" } } }] })
    );
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.seriesId, "L-JA");
    assert.equal(r.title, "Um Filme");
  });
});

describe("próximo lançamento", () => {
  const now = Date.now();
  const at = (days) => now + days * DAY;

  test("série em dia: informa o próximo episódio agendado", async () => {
    const { analyzer } = setup({
      watchlist: [series("X")],
      seasons: { X: [{ id: "T", season_sequence_number: 1 }] },
      episodes: {
        T: [episode("e1", 1), episode("e2", 2, { availableAt: at(3) }), episode("e3", 3, { availableAt: at(10) })],
      },
      playheads: { e1: playhead("e1", FULL, true) },
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.status, "uptodate");
    assert.equal(r.next.id, "e2");
    assert.equal(r.next.number, "2");
    assert.ok(Math.abs(r.next.at - at(3)) < 1000);
  });

  test("modo dublado: usa a data da dublagem, não a do original", async () => {
    const v = (n) => [
      { guid: `j${n}`, audio_locale: "ja-JP", original: true },
      { guid: `p${n}`, audio_locale: "pt-BR" },
    ];
    const { analyzer } = setup({
      watchlist: [series("D")],
      seasons: {
        D: [
          {
            id: "SJ",
            season_sequence_number: 1,
            versions: [
              { guid: "SJ", audio_locale: "ja-JP", original: true },
              { guid: "SP", audio_locale: "pt-BR" },
            ],
          },
        ],
      },
      episodes: {
        SP: [
          episode("p1", 1, { audio: "pt-BR", versions: v(1) }),
          episode("p2", 2, { audio: "pt-BR", versions: v(2), availableAt: at(14) }),
        ],
        SJ: [episode("j1", 1, { versions: v(1) }), episode("j2", 2, { versions: v(2), availableAt: at(1) })],
      },
      playheads: { p1: playhead("p1", FULL, true) },
    });
    const [r] = await analyzer.run({ settings: settings({ defaultMode: "dub" }) });
    assert.equal(r.next.id, "p2");
    assert.ok(Math.abs(r.next.at - at(14)) < 1000);
  });

  test("data '9998' (sem data) e lançamentos já passados são ignorados", async () => {
    const { analyzer } = setup({
      watchlist: [series("X")],
      seasons: { X: [{ id: "T", season_sequence_number: 1 }] },
      episodes: {
        T: [
          episode("e1", 1),
          { ...episode("e2", 2), availability_starts: "9998-11-30T17:45:00Z", premium_available_date: "9998-11-30T17:45:00Z" },
        ],
      },
      playheads: { e1: playhead("e1", FULL, true) },
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.next, null);
  });

  test("com episódios pendentes, também informa o próximo agendado", async () => {
    const { analyzer } = setup({
      watchlist: [series("X")],
      seasons: { X: [{ id: "T", season_sequence_number: 1 }] },
      episodes: { T: [episode("e1", 1), episode("e2", 2), episode("e3", 3, { availableAt: at(5) })] },
      playheads: { e1: playhead("e1", FULL, true) },
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.deepEqual(ids(r), ["e2"]);
    assert.equal(r.next.id, "e3");
  });
});

describe("atalho pelo histórico de reprodução", () => {
  function withHistory(history, watchlist, { fail = false } = {}) {
    const calls = [];
    const CRApi = {
      getAccountId: async () => "conta",
      watchlist: async () => watchlist,
      watchHistory: async () => {
        if (fail) throw new Error("HTTP 500 em watch-history");
        return history;
      },
      seasons: async (id) => (calls.push(id), [{ id: `T-${id}`, season_sequence_number: 1, season_tags: ["Outono-2026", "fall-2026"], audio_locale: "ja-JP" }]),
      episodes: async (id) => (epCalls.push(id), [episode(`${id}-e1`, 1)]),
      playheads: async () => new Map(),
    };
    const epCalls = [];
    const quiet = { ...console, warn: () => {} };
    const ctx = load(["src/analyzer.js"], { browser: fakeBrowser(), CRApi, console: quiet });
    return { analyzer: ctx.CRAnalyzer, calls, epCalls };
  }
  const H = (entries, complete = true) => ({ entries, complete });
  const play = (parent, secs, fully = false) => ({ parent_id: parent, playhead: secs, fully_watched: fully, date_played: "2026-10-01T00:00:00Z" });

  test("histórico completo + never_watched + ausente: só as temporadas, 'never'", async () => {
    const { analyzer, calls, epCalls } = withHistory(H([play("OUTRA", 1400, true)]), [series("A", { never_watched: true })]);
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.status, "never");
    assert.equal(r.viaHistory, true);
    assert.deepEqual(calls, ["A"], "uma consulta: temporadas");
    assert.deepEqual(epCalls, [], "nenhuma lista de episódios");
    assert.deepEqual(plain(r.launch), { season: "fall", year: 2026 }, "com a temporada de lançamento");
    assert.equal(analyzer.dubStatus(r, "ja-JP"), "yes", "e os áudios");
  });

  test("aparece no histórico: análise completa (mesmo com never_watched)", async () => {
    const { analyzer, calls } = withHistory(H([play("A", 1400, true)]), [series("A", { never_watched: true })]);
    await analyzer.run({ settings: settings() });
    assert.deepEqual(calls, ["A"]);
  });

  test("sem never_watched da Crunchyroll: análise completa", async () => {
    const { analyzer, calls } = withHistory(H([]), [series("A", { never_watched: false })]);
    await analyzer.run({ settings: settings() });
    assert.deepEqual(calls, ["A"]);
  });

  test("histórico incompleto: ausência não prova nada, análise completa", async () => {
    const { analyzer, calls } = withHistory(H([], false), [series("A", { never_watched: true })]);
    await analyzer.run({ settings: settings() });
    assert.deepEqual(calls, ["A"]);
  });

  test("histórico indisponível: segue normalmente", async () => {
    const { analyzer, calls } = withHistory(null, [series("A", { never_watched: true })], { fail: true });
    const [r] = await analyzer.run({ settings: settings() });
    assert.deepEqual(calls, ["A"]);
    assert.notEqual(r.status, "error");
  });

  test("registros curtos no histórico não contam como atividade", async () => {
    const { analyzer, epCalls } = withHistory(H([play("A", 5)]), [series("A", { never_watched: true })]);
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.status, "never");
    assert.equal(r.viaHistory, true);
    assert.deepEqual(epCalls, []);
  });

  test("filmes usam o mesmo atalho (parent_id = título do filme)", async () => {
    const { analyzer, calls } = withHistory(H([]), [
      { never_watched: true, panel: { type: "movie_listing", id: "L1", title: "Filme" } },
    ]);
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.kind, "movie");
    assert.equal(r.status, "never");
    assert.deepEqual(calls, []);
  });
});

describe("revalidar só o que mudou", () => {
  const MIN = 60000;
  function world() {
    const state = {
      seasons: [{ id: "T", season_sequence_number: 1, number_of_episodes: 3 }],
      eps: [episode("e1", 1), episode("e2", 2), episode("e3", 3)],
      ph: { e1: playhead("e1", FULL, true) },
      history: { entries: [{ parent_id: "X", playhead: FULL, fully_watched: true, date_played: "2026-10-01T00:00:00Z" }], complete: true },
    };
    const calls = [];
    const CRApi = {
      getAccountId: async () => "conta",
      watchlist: async () => [series("X")],
      watchHistory: async () => state.history,
      seasons: async () => (calls.push("seasons"), state.seasons),
      episodes: async () => (calls.push("episodes"), state.eps),
      playheads: async (ids) => (calls.push("playheads"), new Map(ids.filter((i) => state.ph[i]).map((i) => [i, state.ph[i]]))),
    };
    const browser = fakeBrowser();
    const ctx = load(["src/analyzer.js"], { browser, CRApi });
    // Envelhece a análise guardada no cache.
    const age = (ms) => {
      const all = browser.storage.local.data["crnovos:v7:cache"];
      for (const scope of Object.values(all)) {
        for (const r of Object.values(scope)) {
          r.checkedAt -= ms;
          if (r.revalidatedAt) r.revalidatedAt -= ms;
        }
      }
    };
    const run = async () => (await ctx.CRAnalyzer.run({ settings: settings() }))[0];
    const take = () => calls.splice(0);
    return { state, run, age, take };
  }

  test("depois de 5 min, sem mudanças: só temporadas e a lista de episódios mais recente", async () => {
    const w = world();
    await w.run();
    w.take();
    w.age(6 * MIN);
    const r = await w.run();
    assert.deepEqual(w.take(), ["seasons", "episodes"]);
    assert.deepEqual(ids(r), ["e2", "e3"]);
  });

  test("revalidada, vale mais 5 min sem nenhuma consulta", async () => {
    const w = world();
    await w.run();
    w.age(30 * MIN);
    await w.run();
    w.take();
    await w.run();
    assert.deepEqual(w.take(), []);
  });

  test("episódio novo na temporada (contagem muda): análise completa", async () => {
    const w = world();
    await w.run();
    w.take();
    w.age(30 * MIN);
    w.state.seasons = [{ id: "T", season_sequence_number: 1, number_of_episodes: 4 }];
    w.state.eps = [...w.state.eps, episode("e4", 4)];
    const r = await w.run();
    assert.deepEqual(w.take(), ["seasons", "episodes", "playheads"]);
    assert.deepEqual(ids(r), ["e2", "e3", "e4"]);
  });

  test("episódio novo sem mudar as temporadas (contagem já incluía ele): análise completa", async () => {
    const w = world();
    w.state.seasons = [{ id: "T", season_sequence_number: 1, number_of_episodes: 4 }];
    await w.run();
    w.take();
    w.age(6 * MIN);
    w.state.eps = [...w.state.eps, episode("e4", 4)];
    const r = await w.run();
    assert.deepEqual(w.take(), ["seasons", "episodes", "episodes", "playheads"]);
    assert.deepEqual(ids(r), ["e2", "e3", "e4"]);
  });

  test("episódio já listado com data futura é liberado: análise completa", async () => {
    const w = world();
    const later = Date.now() + 300;
    w.state.eps = [episode("e1", 1), episode("e2", 2, { availableAt: later })];
    w.state.ph = { e1: playhead("e1", FULL, true) };
    const before = await w.run();
    assert.deepEqual(ids(before), []);
    w.take();
    w.age(6 * MIN);
    await new Promise((r) => setTimeout(r, 350));
    const r = await w.run();
    assert.ok(w.take().includes("playheads"), "refez a análise");
    assert.deepEqual(ids(r), ["e2"]);
  });

  test("episódio ganha versão de áudio nova (dublagem lançada): análise completa", async () => {
    const w = world();
    w.state.eps = w.state.eps.map((e) => ({ ...e, versions: [{ guid: e.id, audio_locale: "ja-JP", original: true }] }));
    await w.run();
    w.take();
    w.age(6 * MIN);
    w.state.eps = w.state.eps.map((e, i) =>
      i === 1 ? { ...e, versions: [...e.versions, { guid: e.id + "-pt", audio_locale: "pt-BR" }] } : e
    );
    await w.run();
    assert.ok(w.take().includes("playheads"), "refez a análise");
  });

  test("erro na revalidação dos episódios: segue para a análise completa", async () => {
    const w = world();
    await w.run();
    w.take();
    w.age(6 * MIN);
    let first = true;
    const orig = w.state.eps;
    Object.defineProperty(w.state, "eps", {
      get() {
        if (first) {
          first = false;
          throw new Error("HTTP 500");
        }
        return orig;
      },
    });
    const r = await w.run();
    assert.notEqual(r.status, "error");
    assert.deepEqual(ids(r), ["e2", "e3"]);
  });

  test("você assistiu algo (histórico mudou): análise completa", async () => {
    const w = world();
    await w.run();
    w.take();
    w.age(30 * MIN);
    w.state.history = { entries: [{ parent_id: "X", playhead: FULL, fully_watched: true, date_played: "2026-10-13T20:00:00Z" }], complete: true };
    w.state.ph.e2 = playhead("e2", FULL, true);
    const r = await w.run();
    assert.ok(w.take().includes("episodes"));
    assert.deepEqual(ids(r), ["e3"]);
  });

  test("lançamento agendado que já passou: análise completa", async () => {
    const w = world();
    w.state.eps = [episode("e1", 1), episode("e2", 2, { availableAt: Date.now() + 1000 })];
    await w.run();
    w.take();
    w.age(30 * MIN);
    await new Promise((r) => setTimeout(r, 1100)); // o lançamento passa
    await w.run();
    assert.ok(w.take().includes("episodes"));
  });

  test("análise com mais de 6 h: completa, mesmo sem mudanças", async () => {
    const w = world();
    await w.run();
    w.take();
    w.age(7 * 60 * MIN);
    await w.run();
    assert.deepEqual(w.take(), ["seasons", "episodes", "playheads"]);
  });

  test("histórico incompleto sem a série: não arrisca, análise completa", async () => {
    const w = world();
    w.state.history = { entries: [], complete: false };
    await w.run();
    w.take();
    w.age(30 * MIN);
    await w.run();
    assert.ok(w.take().includes("episodes"));
  });
});

describe("dados reais: OVERLORD: O Reino Sagrado (versões da temporada misturam IDs de episódio)", () => {
  const fx = require("./fixtures/overlord-sacred-kingdom.json");
  const SERIES = "GMTE00334078";
  const EP_IDS = new Set(fx.episodesPTBR[0].versions.map((v) => v.guid));
  const jaEps = fx.episodesPTBR.map((e) => ({ ...e, id: "G8WU7P32E", audio_locale: "ja-JP", season_id: "GMSE00334078JAJP" }));

  function run(mode, playheads = {}) {
    const asked = [];
    const CRApi = {
      getAccountId: async () => "conta-1",
      watchlist: async () => [series(SERIES)],
      seasons: async () => fx.seasons,
      episodes: async (id) => {
        asked.push(id);
        if (EP_IDS.has(id)) {
          const err = new Error(`HTTP 400 em /content/v2/cms/seasons/${id}/episodes`);
          err.status = 400;
          throw err;
        }
        if (id === "GMSE00334078PTBR") return fx.episodesPTBR;
        if (id === "GMSE00334078JAJP") return jaEps;
        return [];
      },
      playheads: async (ids) => new Map(ids.filter((i) => playheads[i]).map((i) => [i, playheads[i]])),
    };
    const quiet = { ...console, warn: () => {} };
    const ctx = load(["src/analyzer.js"], { browser: fakeBrowser(), CRApi, console: quiet });
    return ctx.CRAnalyzer.run({ settings: settings({ defaultMode: mode }) }).then(([r]) => ({ r, asked }));
  }

  test("a resposta real traz IDs de episódio entre as versões da temporada", () => {
    const vs = fx.seasons[0].versions.map((v) => v.guid);
    assert.ok(vs.includes("G8WU7P32E") && vs.includes("GMSE00334078JAJP"));
  });

  for (const mode of ["sub", "dub", "auto"]) {
    test(`modo ${mode}: não dá erro; pula o ID recusado e usa a temporada certa`, async () => {
      const { r, asked } = await run(mode);
      assert.notEqual(r.status, "error", r.error);
      assert.equal(r.status, "never");
      if (mode !== "auto") assert.ok(!asked.slice(-1).some((id) => EP_IDS.has(id)), "terminou numa temporada válida");
    });
  }

  test("modo legendado: filme assistido (qualquer versão) fica em dia", async () => {
    const { r } = await run("sub", { G8WU7P32E: playhead("G8WU7P32E", FULL, true) });
    assert.equal(r.status, "uptodate");
  });

  test("outros erros da API continuam aparecendo como erro", async () => {
    const CRApi = {
      getAccountId: async () => "conta-1",
      watchlist: async () => [series(SERIES)],
      seasons: async () => fx.seasons,
      episodes: async () => {
        const err = new Error("HTTP 500");
        err.status = 500;
        throw err;
      },
      playheads: async () => new Map(),
    };
    const quiet = { ...console, warn: () => {} };
    const ctx = load(["src/analyzer.js"], { browser: fakeBrowser(), CRApi, console: quiet });
    const [r] = await ctx.CRAnalyzer.run({ settings: settings({ defaultMode: "sub" }) });
    assert.equal(r.status, "error");
  });
});

describe("ícone de dublagem: áudios guardados por série", () => {
  const S = (id, seq, audio, versions = []) => ({ id, season_sequence_number: seq, audio_locale: audio, versions });

  test("guarda os áudios da temporada mais recente e de todas", async () => {
    const { analyzer } = setup({
      watchlist: [series("A")],
      seasons: {
        A: [
          S("A1", 1, "ja-JP", [{ guid: "A1", audio_locale: "ja-JP", original: true }, { guid: "A1PT", audio_locale: "pt-BR" }]),
          S("A2", 2, "ja-JP", [{ guid: "A2", audio_locale: "ja-JP", original: true }, { guid: "A2EN", audio_locale: "en-US" }]),
        ],
      },
      episodes: { A2: [episode("a1", 1)] },
      playheads: { a1: playhead("a1", FULL, true) },
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.deepEqual(plain(r.audios.latest).sort(), ["en-US", "ja-JP"]);
    assert.deepEqual(plain(r.audios.any).sort(), ["en-US", "ja-JP", "pt-BR"]);
    assert.equal(analyzer.dubStatus(r, "en-US"), "yes");
    assert.equal(analyzer.dubStatus(r, "pt-BR"), "old", "só a 1ª temporada tem pt-BR");
    assert.equal(analyzer.dubStatus(r, "es-419"), "no");
  });

  test("série nunca assistida também guarda os áudios (vem da lista de temporadas)", async () => {
    const { analyzer } = setup({
      watchlist: [series("B")],
      seasons: { B: [S("B1", 1, "pt-BR", [])] },
      episodes: { B1: [episode("b1", 1)] },
      playheads: {},
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(r.status, "never");
    assert.equal(analyzer.dubStatus(r, "pt-BR"), "yes");
  });

  test("audio_locales da temporada também conta", () => {
    const { analyzer } = setup({ watchlist: [], seasons: {}, episodes: {}, playheads: {} });
    const a = analyzer.seriesAudios([{ id: "X", audio_locale: "ja-JP", audio_locales: ["ja-JP", "pt-BR"] }]);
    assert.equal(analyzer.dubStatus({ audios: a }, "pt-BR"), "yes");
  });

  test("sem informação (série não consultada): nenhum ícone", () => {
    const { analyzer } = setup({ watchlist: [], seasons: {}, episodes: {}, playheads: {} });
    assert.equal(analyzer.dubStatus({}, "pt-BR"), null);
    assert.equal(analyzer.dubStatus({ audios: null }, "pt-BR"), null);
    assert.equal(analyzer.seriesAudios([]), null);
  });

  test("dados reais: OVERLORD: O Reino Sagrado tem dublagem pt-BR", async () => {
    const fx = require("./fixtures/overlord-sacred-kingdom.json");
    const a = (() => {
      const { analyzer } = setup({ watchlist: [], seasons: {}, episodes: {}, playheads: {} });
      return { analyzer, audios: analyzer.seriesAudios(fx.seasons) };
    })();
    assert.equal(a.analyzer.dubStatus({ audios: a.audios }, "pt-BR"), "yes");
    assert.equal(a.analyzer.dubStatus({ audios: a.audios }, "it-IT"), "no");
  });

  test("dados reais: No Longer Allowed in Another World não tem pt-BR", () => {
    const eps = require("./fixtures/no-longer-allowed-s1-episodes.json").data;
    const v = eps[0].versions.map((x) => ({ guid: x.guid, audio_locale: x.audio_locale }));
    const { analyzer } = setup({ watchlist: [], seasons: {}, episodes: {}, playheads: {} });
    const a = analyzer.seriesAudios([{ id: "S", audio_locale: "ja-JP", versions: v }]);
    assert.equal(analyzer.dubStatus({ audios: a }, "pt-BR"), "no");
    assert.equal(analyzer.dubStatus({ audios: a }, "en-US"), "yes");
  });

  test("filmes: áudios das versões que têm filme", async () => {
    const { analyzer } = setup({
      watchlist: [{ panel: { type: "movie_listing", id: "M", title: "Filme", slug_title: "filme" } }],
      seasons: {},
      episodes: {},
      movieListings: {
        M: { id: "M", versions: [{ guid: "MJ", audio_locale: "ja-JP", original: true }, { guid: "MP", audio_locale: "pt-BR" }, { guid: "ME", audio_locale: "en-US" }] },
      },
      movies: { MJ: [{ id: "mj1", duration_ms: 1000 }], MP: [{ id: "mp1", duration_ms: 1000 }], ME: [] },
      playheads: {},
    });
    const [r] = await analyzer.run({ settings: settings() });
    assert.equal(analyzer.dubStatus(r, "pt-BR"), "yes");
    assert.equal(analyzer.dubStatus(r, "en-US"), "no", "versão sem filme não conta");
  });
});

test("as temporadas são pedidas com o idioma de dublagem como preferred_audio_language", async () => {
  const asked = [];
  const CRApi = {
    getAccountId: async () => "c",
    watchlist: async () => [series("A")],
    seasons: async (id, locale, audio) => (asked.push([id, locale, audio]), []),
    episodes: async () => [],
    playheads: async () => new Map(),
  };
  const ctx = load(["src/analyzer.js"], { browser: fakeBrowser(), CRApi });
  await ctx.CRAnalyzer.run({ settings: settings({ dubLang: "es-419" }) });
  assert.deepEqual(plain(asked), [["A", "pt-BR", "es-419"]]);
});

describe("temporada de lançamento (aba Ainda não começadas)", () => {
  const { analyzer } = setup({ watchlist: [], seasons: {}, episodes: {}, playheads: {} });
  const P = (t) => plain(analyzer.parseSeasonTag(t));

  test("etiquetas traduzidas e em inglês", () => {
    assert.deepEqual(P("Outono-2019"), { season: "fall", year: 2019 });
    assert.deepEqual(P("fall-2019"), { season: "fall", year: 2019 });
    assert.deepEqual(P("Verão-2026"), { season: "summer", year: 2026 });
    assert.deepEqual(P("Primavera-2025"), { season: "spring", year: 2025 });
    assert.deepEqual(P("Inverno-2024"), { season: "winter", year: 2024 });
    assert.deepEqual(P("winter-2024"), { season: "winter", year: 2024 });
    assert.deepEqual(P("Otoño-2023"), { season: "fall", year: 2023 });
    assert.deepEqual(P("Frühling-2023"), { season: "spring", year: 2023 });
  });

  test("etiquetas desconhecidas ou malformadas são ignoradas", () => {
    assert.equal(analyzer.parseSeasonTag("simulcast"), null);
    assert.equal(analyzer.parseSeasonTag("fall"), null);
    assert.equal(analyzer.parseSeasonTag(""), null);
    assert.equal(analyzer.parseSeasonTag(undefined), null);
  });

  test("usa a temporada mais recente que tiver etiqueta", () => {
    const l = analyzer.seriesLaunch([
      { id: "1", season_tags: ["Outono-2019"] },
      { id: "2", season_tags: ["Verão-2026", "summer-2026"] },
      { id: "3", season_tags: [] },
    ]);
    assert.deepEqual(plain(l), { season: "summer", year: 2026 });
    assert.equal(analyzer.seriesLaunch([{ id: "x" }]), null);
  });

  test("série nunca assistida guarda a temporada de lançamento", async () => {
    const { analyzer: a } = setup({
      watchlist: [series("N")],
      seasons: { N: [{ id: "N1", season_sequence_number: 1, season_tags: ["Primavera-2026"] }] },
      episodes: { N1: [episode("n1", 1)] },
      playheads: {},
    });
    const [r] = await a.run({ settings: settings() });
    assert.equal(r.status, "never");
    assert.deepEqual(plain(r.launch), { season: "spring", year: 2026 });
  });
});

describe("Fila + Crunchylists", () => {
  const db = (over = {}) => ({
    watchlist: [series("A", { never_watched: true }), series("B")],
    lists: { L1: [series("B"), series("C")], L2: [series("D")] },
    seasons: {},
    episodes: {},
    playheads: {},
    ...over,
  });

  test("sem escolha, lê só a Fila (como antes)", async () => {
    const { analyzer, calls } = setup(db());
    const r = await analyzer.run({ settings: settings() });
    assert.deepEqual(plain(r.map((x) => x.seriesId)), ["A", "B"]);
    assert.ok(!calls.some((c) => c[0] === "customList"));
    assert.deepEqual(plain(r[0].lists), ["watchlist"]);
  });

  test("junta Fila e Crunchylists sem repetir série e guarda de onde cada uma veio", async () => {
    const { analyzer } = setup(db());
    const r = await analyzer.run({ settings: settings({ sources: ["watchlist", "L1"] }) });
    const by = Object.fromEntries(r.map((x) => [x.seriesId, plain(x.lists)]));
    assert.deepEqual(by, { A: ["watchlist"], B: ["watchlist", "L1"], C: ["L1"] });
  });

  test("só Crunchylists, sem a Fila", async () => {
    const { analyzer, calls } = setup(db());
    const r = await analyzer.run({ settings: settings({ sources: ["L2"] }) });
    assert.deepEqual(plain(r.map((x) => x.seriesId)), ["D"]);
    assert.ok(!calls.some((c) => c[0] === "watchlist"));
  });

  test("a marca 'nunca assistida' da Fila vale mesmo se a série também está numa Crunchylist", () => {
    const { analyzer } = setup(db());
    const merged = analyzer.mergeSources([
      { id: "L1", items: [series("A")] },
      { id: "watchlist", items: [series("A", { never_watched: true })] },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].neverWatchedFlag, true);
    assert.deepEqual(plain(merged[0].lists), ["L1", "watchlist"]);
  });

  test("lista apagada no site (404) é ignorada; outro erro interrompe", async () => {
    const ok = setup(db({ missingLists: ["L9"] }));
    const r = await ok.analyzer.run({ settings: settings({ sources: ["watchlist", "L9"] }) });
    assert.deepEqual(plain(r.map((x) => x.seriesId)), ["A", "B"]);
    const bad = setup(db({ brokenLists: ["L1"] }));
    await assert.rejects(bad.analyzer.run({ settings: settings({ sources: ["watchlist", "L1"] }) }), /500/);
  });

  test("listSources: remove repetidos e inválidos; vazio vira a Fila", () => {
    const { analyzer } = setup(db());
    assert.deepEqual(plain(analyzer.listSources({})), ["watchlist"]);
    assert.deepEqual(plain(analyzer.listSources({ sources: [] })), ["watchlist"]);
    assert.deepEqual(plain(analyzer.listSources({ sources: ["L1", "L1", "", null, "watchlist"] })), ["L1", "watchlist"]);
  });

  test("o cache não muda as listas de origem de uma série", async () => {
    const { analyzer } = setup(db());
    await analyzer.run({ settings: settings({ sources: ["watchlist"] }) });
    const r = await analyzer.run({ settings: settings({ sources: ["watchlist", "L1"] }) });
    assert.deepEqual(plain(r.find((x) => x.seriesId === "B").lists), ["watchlist", "L1"]);
  });
});
