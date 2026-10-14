"use strict";
// Leitura da Fila e do histórico: páginas pedidas juntas, limite de consultas
// simultâneas e Fila + histórico ao mesmo tempo.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeBrowser, jwt, plain, episode } = require("./helpers");

const ACC = "11111111-2222-3333-4444-555555555555";
const json = (obj) => new Response(JSON.stringify(obj), { status: 200 });
const tick = () => new Promise((r) => setTimeout(r, 5));

/** API com fetch falso que registra quantas requisições ficaram abertas ao mesmo tempo. */
function setup(routes) {
  const requests = [];
  const stats = { open: 0, maxOpen: 0 };
  const fetch = async (url, init = {}) => {
    requests.push({ url, ...init });
    stats.open++;
    stats.maxOpen = Math.max(stats.maxOpen, stats.open);
    await tick(); // todas as que já foram disparadas ficam abertas juntas
    stats.open--;
    return routes(new URL(url));
  };
  const browser = fakeBrowser();
  browser.storage.session.data.crToken = {
    token: jwt({ account_id: ACC, exp: Math.floor(Date.now() / 1000) + 600 }),
    exp: Date.now() + 600000,
  };
  const ctx = load(["src/api.js"], { browser, fetch, Response });
  return { api: ctx.CRApi, requests, stats };
}

const rows = (n, prefix) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));
const param = (r, k) => new URL(r.url).searchParams.get(k);

describe("Fila em páginas paralelas", () => {
  const fila = (total, { withTotal = true } = {}) => (url) => {
    const start = Number(url.searchParams.get("start"));
    const data = rows(Math.max(0, Math.min(100, total - start)), `s${start}-`);
    return json(withTotal ? { data, total } : { data });
  };
  const starts = (requests) => plain(requests.map((r) => param(r, "start")));

  test("sem leitura anterior: a primeira leva já pede várias páginas juntas", async () => {
    const { api, requests, stats } = setup(fila(350));
    const items = await api.watchlist("pt-BR", { parallel: 4 });
    assert.equal(items.length, 350);
    assert.deepEqual(starts(requests), ["0", "100", "200", "300"]);
    assert.equal(stats.maxOpen, 4, "as 4 páginas ficaram abertas ao mesmo tempo");
    // Ordem preservada, mesmo com respostas em paralelo.
    assert.equal(items[0].id, "s0-0");
    assert.equal(items[349].id, "s300-49");
  });

  test("da segunda vez, pede exatamente as páginas da leitura anterior, todas juntas", async () => {
    const { api, requests, stats } = setup(fila(350));
    await api.watchlist("pt-BR", { parallel: 16 }); // 1ª leitura: leva de 16, sobram 12
    assert.equal(requests.length, 16);
    requests.length = 0;
    stats.maxOpen = 0;
    const items = await api.watchlist("pt-BR", { parallel: 16 });
    assert.equal(items.length, 350);
    assert.deepEqual(starts(requests), ["0", "100", "200", "300"]);
    assert.equal(stats.maxOpen, 4);
  });

  test("Fila pequena: depois da primeira leitura, uma consulta só", async () => {
    const { api, requests } = setup(fila(40));
    assert.equal((await api.watchlist("pt-BR")).length, 40);
    requests.length = 0;
    assert.equal((await api.watchlist("pt-BR")).length, 40);
    assert.equal(requests.length, 1);
  });

  test("Fila cresceu desde a última leitura: continua em outra leva", async () => {
    let total = 150;
    const { api, requests } = setup((url) => fila(total)(url));
    await api.watchlist("pt-BR", { parallel: 4 });
    total = 520;
    requests.length = 0;
    const items = await api.watchlist("pt-BR", { parallel: 4 });
    assert.equal(items.length, 520);
    assert.deepEqual(starts(requests), ["0", "100", "200", "300", "400", "500"]);
  });

  test("respeita o limite de consultas simultâneas", async () => {
    const { api, stats } = setup(fila(1000));
    const items = await api.watchlist("pt-BR", { parallel: 2 });
    assert.equal(items.length, 1000);
    assert.equal(stats.maxOpen, 2);
  });

  test("sem total na resposta também lê tudo em paralelo", async () => {
    const { api, stats } = setup(fila(250, { withTotal: false }));
    assert.equal((await api.watchlist("pt-BR", { parallel: 4 })).length, 250);
    assert.equal(stats.maxOpen, 4);
  });

  test("página da Fila que falha antes do fim gera erro (não esconde séries)", async () => {
    const { api } = setup((url) =>
      url.searchParams.get("start") === "100" ? new Response("x", { status: 500 }) : fila(350)(url)
    );
    await assert.rejects(api.watchlist("pt-BR"), /HTTP 500/);
  });
});

describe("histórico em páginas paralelas", () => {
  // `total` = registros que a API diz ter; `real` = registros que ela realmente devolve.
  // Por padrão SEM total, como a resposta real do watch-history.
  const historico = ({ real, total, failFrom } = {}) => (url) => {
    const page = Number(url.searchParams.get("page"));
    if (failFrom && page >= failFrom) return new Response("nao", { status: 404 });
    const start = (page - 1) * 100;
    const n = Math.max(0, Math.min(100, real - start));
    const body = { data: rows(n, `h${page}-`), meta: { next_page: start + n < real ? `/p${page + 1}` : "" } };
    if (total !== undefined) body.total = total;
    return json(body);
  };
  const pages = (requests) => plain(requests.map((r) => param(r, "page")));

  test("sem total (resposta real): páginas pedidas juntas e histórico completo", async () => {
    const { api, requests, stats } = setup(historico({ real: 340 }));
    const h = await api.watchHistory("pt-BR", { parallel: 4 });
    assert.equal(h.entries.length, 340);
    assert.equal(h.complete, true);
    assert.deepEqual(pages(requests), ["1", "2", "3", "4"]);
    assert.equal(stats.maxOpen, 4);
  });

  test("histórico longo: levas sucessivas, cada uma em paralelo", async () => {
    const { api, requests, stats } = setup(historico({ real: 900 }));
    const h = await api.watchHistory("pt-BR", { parallel: 3 });
    assert.equal(h.entries.length, 900);
    assert.equal(h.complete, true);
    assert.equal(requests.length, 9);
    assert.equal(stats.maxOpen, 3);
  });

  test("da segunda vez, uma leva só com o número de páginas da anterior", async () => {
    const { api, requests, stats } = setup(historico({ real: 700 }));
    await api.watchHistory("pt-BR", { parallel: 4 });
    requests.length = 0;
    stats.maxOpen = 0;
    const h = await api.watchHistory("pt-BR", { parallel: 4 });
    assert.equal(h.entries.length, 700);
    assert.deepEqual(pages(requests), ["1", "2", "3", "4", "5", "6", "7"]);
    assert.equal(stats.maxOpen, 4, "o limite de simultâneas continua valendo");
  });

  test("mais páginas que o limite: lê só até o limite e marca como incompleto", async () => {
    const { api, requests } = setup(historico({ real: 5000 }));
    const h = await api.watchHistory("pt-BR", { maxPages: 4, parallel: 8 });
    assert.equal(requests.length, 4);
    assert.equal(h.entries.length, 400);
    assert.equal(h.complete, false);
  });

  test("erro em página depois do fim é ignorado", async () => {
    const { api } = setup(historico({ real: 150, failFrom: 3 }));
    const h = await api.watchHistory("pt-BR", { parallel: 4 });
    assert.equal(h.entries.length, 150);
    assert.equal(h.complete, true);
  });

  test("erro antes do fim: aproveita o que veio e marca como incompleto", async () => {
    const { api } = setup(historico({ real: 900, failFrom: 3 }));
    const h = await api.watchHistory("pt-BR", { parallel: 4 });
    assert.equal(h.entries.length, 200);
    assert.equal(h.complete, false);
  });

  // Formato real (HAR de out/2026): "total" = registros da página (100), não do
  // histórico; next_page com cursor; histórico maior que o limite de 10 páginas.
  // A 0.4.1 confiava nesse "total" e lia as 10 páginas uma por uma (~9 s).
  const formatoReal = (real) => (url) => {
    const page = Number(url.searchParams.get("page"));
    const start = (page - 1) * 100;
    const n = Math.max(0, Math.min(100, real - start));
    return json({
      total: n,
      data: rows(n, `h${page}-`),
      meta: { prev_page: page > 1 ? "/x?page=cursorAnterior" : "", next_page: start + n < real ? "/x?page=eyJjIjoiWCJ9" : "" },
    });
  };

  test("formato real: total da página não engana; 10 páginas em paralelo", async () => {
    const { api, requests, stats } = setup(formatoReal(5000));
    const h = await api.watchHistory("pt-BR", { parallel: 4 });
    assert.equal(h.entries.length, 1000);
    assert.equal(h.complete, false);
    assert.equal(requests.length, 10);
    assert.equal(stats.maxOpen, 4);
  });

  test("formato real: depois da primeira vez, as 10 páginas saem sem esperar levas", async () => {
    const { api, requests, stats } = setup(formatoReal(5000));
    await api.watchHistory("pt-BR", { parallel: 10 });
    requests.length = 0;
    stats.maxOpen = 0;
    const h = await api.watchHistory("pt-BR", { parallel: 10 });
    assert.equal(h.entries.length, 1000);
    assert.equal(requests.length, 10, "nenhuma página a mais");
    assert.equal(stats.maxOpen, 10, "todas abertas ao mesmo tempo");
  });

  test("formato real com histórico curto (340): completo e sem páginas perdidas", async () => {
    const { api } = setup(formatoReal(340));
    const h = await api.watchHistory("pt-BR", { parallel: 4 });
    assert.equal(h.entries.length, 340);
    assert.equal(h.complete, true);
    assert.equal(new Set(h.entries.map((e) => e.id)).size, 340);
  });

  test("com total na resposta funciona igual", async () => {
    const { api } = setup(historico({ real: 340, total: 340 }));
    const h = await api.watchHistory("pt-BR", { parallel: 4 });
    assert.equal(h.entries.length, 340);
    assert.equal(h.complete, true);
  });
});

describe("Fila e histórico ao mesmo tempo", () => {
  test("a API: as duas leituras ficam abertas juntas", async () => {
    const { api, stats } = setup((url) =>
      url.pathname.includes("watch-history") ? json({ data: rows(5, "h"), total: 5, meta: { next_page: "" } }) : json({ data: rows(5, "s"), total: 5 })
    );
    await Promise.all([api.watchlist("pt-BR", { parallel: 1 }), api.watchHistory("pt-BR", { parallel: 1 })]);
    assert.equal(stats.maxOpen, 2);
  });

  test("sem ID da conta no token, as duas leituras descobrem o ID uma vez só", async () => {
    const requests = [];
    const fetch = async (url) => {
      requests.push(url);
      await tick();
      const u = new URL(url);
      if (u.pathname === "/accounts/v1/me") return json({ account_id: ACC });
      return json({ data: [], total: 0, meta: { next_page: "" } });
    };
    const browser = fakeBrowser();
    browser.storage.session.data.crToken = { token: jwt({ exp: Math.floor(Date.now() / 1000) + 600 }), exp: Date.now() + 600000 };
    const { CRApi } = load(["src/api.js"], { browser, fetch, Response });
    await Promise.all([CRApi.watchlist("pt-BR"), CRApi.watchHistory("pt-BR"), CRApi.getAccountId()]);
    assert.equal(requests.filter((u) => u.endsWith("/accounts/v1/me")).length, 1);
  });

  test("o analisador começa a ler o histórico sem esperar a Fila (e passa o limite configurado)", async () => {
    const log = [];
    let releaseWatchlist;
    const watchlistGate = new Promise((r) => (releaseWatchlist = r));
    const CRApi = {
      getAccountId: async () => "conta",
      watchlist: async (_locale, opts) => {
        log.push(["watchlist", opts.parallel]);
        await watchlistGate; // só termina depois que o histórico começou
        return [{ panel: { type: "series", id: "A", title: "A", slug_title: "a" } }];
      },
      watchHistory: async (_locale, opts) => {
        log.push(["history", opts.parallel]);
        releaseWatchlist();
        return { entries: [], complete: true };
      },
      seasons: async () => [{ id: "T1", season_sequence_number: 1 }],
      episodes: async () => [episode("e1", 1)],
      playheads: async () => new Map(),
    };
    const { CRAnalyzer } = load(["src/analyzer.js"], { browser: fakeBrowser(), CRApi });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("a Fila esperou o histórico (ou vice-versa)")), 1000));
    const results = await Promise.race([
      CRAnalyzer.run({ settings: { locale: "pt-BR", dubLang: "pt-BR", defaultMode: "sub", seriesModes: {}, concurrency: 6 } }),
      timeout,
    ]);
    assert.equal(results.length, 1);
    assert.deepEqual(plain(log), [
      ["watchlist", 6],
      ["history", 6],
    ]);
  });
});
