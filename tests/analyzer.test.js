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
    seasons: async (id) => {
      calls.push(["seasons", id]);
      if (db.fail && db.fail.includes(id)) throw new Error("HTTP 500 em seasons");
      return db.seasons[id] || [];
    },
    episodes: async (id) => (calls.push(["episodes", id]), db.episodes[id] || []),
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
  test("ignora filmes, aceita painel de episódio e remove séries repetidas", async () => {
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
    assert.equal(results.length, 1);
    assert.equal(results[0].seriesId, "A");
    assert.equal(results[0].title, "Série A");
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

  test("valores inválidos da configuração são ajustados", () => {
    const { analyzer } = setup({ watchlist: [], seasons: {}, episodes: {}, playheads: {} });
    const c = (v) => analyzer.concurrencyFrom({ concurrency: v });
    assert.equal(c(0), 1);
    assert.equal(c(-5), 1);
    assert.equal(c(100), 16);
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
