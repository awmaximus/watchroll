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

  test("primeira página informa o total; as outras saem juntas", async () => {
    const { api, requests, stats } = setup(fila(350));
    const items = await api.watchlist("pt-BR", { parallel: 8 });
    assert.equal(items.length, 350);
    assert.deepEqual(plain(requests.map((r) => param(r, "start"))), ["0", "100", "200", "300"]);
    assert.equal(stats.maxOpen, 3, "as 3 páginas restantes ficaram abertas ao mesmo tempo");
    // Ordem preservada, mesmo com respostas em paralelo.
    assert.equal(items[0].id, "s0-0");
    assert.equal(items[349].id, "s300-49");
  });

  test("respeita o limite de consultas simultâneas", async () => {
    const { api, stats } = setup(fila(1000));
    const items = await api.watchlist("pt-BR", { parallel: 2 });
    assert.equal(items.length, 1000);
    assert.equal(stats.maxOpen, 2);
  });

  test("Fila pequena: uma consulta só", async () => {
    const { api, requests } = setup(fila(40));
    assert.equal((await api.watchlist("pt-BR")).length, 40);
    assert.equal(requests.length, 1);
  });

  test("sem total na resposta: página por página, como antes", async () => {
    const { api, requests, stats } = setup(fila(250, { withTotal: false }));
    assert.equal((await api.watchlist("pt-BR", { parallel: 8 })).length, 250);
    assert.deepEqual(plain(requests.map((r) => param(r, "start"))), ["0", "100", "200"]);
    assert.equal(stats.maxOpen, 1);
  });
});

describe("histórico em páginas paralelas", () => {
  // `total` = registros que a API diz ter; `real` = registros que ela realmente devolve.
  const historico = ({ total, real = total, withTotal = true }) => (url) => {
    const page = Number(url.searchParams.get("page"));
    const start = (page - 1) * 100;
    const n = Math.max(0, Math.min(100, real - start));
    const body = { data: rows(n, `h${page}-`), meta: { next_page: start + n < real ? `/p${page + 1}` : "" } };
    if (withTotal) body.total = total;
    return json(body);
  };

  test("com total: páginas 2..N juntas e histórico completo", async () => {
    const { api, requests, stats } = setup(historico({ total: 340 }));
    const h = await api.watchHistory("pt-BR", { parallel: 8 });
    assert.equal(h.entries.length, 340);
    assert.equal(h.complete, true);
    assert.deepEqual(plain(requests.map((r) => param(r, "page"))), ["1", "2", "3", "4"]);
    assert.equal(stats.maxOpen, 3);
  });

  test("mais páginas que o limite: lê só até o limite e marca como incompleto", async () => {
    const { api, requests } = setup(historico({ total: 5000 }));
    const h = await api.watchHistory("pt-BR", { maxPages: 4, parallel: 8 });
    assert.equal(requests.length, 4);
    assert.equal(h.entries.length, 400);
    assert.equal(h.complete, false);
  });

  test("total desatualizado (há mais do que dizia): continua até o fim", async () => {
    const { api, requests } = setup(historico({ total: 200, real: 260 }));
    const h = await api.watchHistory("pt-BR", { parallel: 8 });
    assert.equal(h.entries.length, 260);
    assert.equal(h.complete, true);
    assert.deepEqual(plain(requests.map((r) => param(r, "page"))), ["1", "2", "3"]);
  });

  test("sem total: página por página, como antes", async () => {
    const { api, requests, stats } = setup(historico({ total: 0, real: 240, withTotal: false }));
    const h = await api.watchHistory("pt-BR", { parallel: 8 });
    assert.equal(h.entries.length, 240);
    assert.equal(h.complete, true);
    assert.equal(requests.length, 3);
    assert.equal(stats.maxOpen, 1);
  });

  test("respeita o limite de consultas simultâneas", async () => {
    const { api, stats } = setup(historico({ total: 900 }));
    await api.watchHistory("pt-BR", { parallel: 3 });
    assert.equal(stats.maxOpen, 3);
  });
});

describe("Fila e histórico ao mesmo tempo", () => {
  test("a API: as duas leituras ficam abertas juntas", async () => {
    const { api, stats } = setup((url) =>
      url.pathname.includes("watch-history") ? json({ data: rows(5, "h"), total: 5, meta: { next_page: "" } }) : json({ data: rows(5, "s"), total: 5 })
    );
    await Promise.all([api.watchlist("pt-BR"), api.watchHistory("pt-BR")]);
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
