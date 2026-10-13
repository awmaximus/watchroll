"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeBrowser, jwt, plain } = require("./helpers");

const ACC = "11111111-2222-3333-4444-555555555555";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

/**
 * Monta o módulo de API com um fetch falso.
 * `routes(url, init)` devolve uma Response (ou lança, para simular falha de rede).
 */
function setup(routes, { browser = fakeBrowser(), sessionToken } = {}) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url, ...init });
    return routes(url, init);
  };
  if (sessionToken) browser.storage.session.data.crToken = sessionToken;
  const ctx = load(["src/api.js"], { browser, fetch, Response });
  return { api: ctx.CRApi, requests, browser };
}

const validSession = (payload = { account_id: ACC }) => ({
  token: jwt({ ...payload, exp: Math.floor(Date.now() / 1000) + 600 }),
  exp: Date.now() + 600000,
});

describe("autenticação", () => {
  test("usa o token que o site estava usando e tira o ID da conta do JWT", async () => {
    const session = validSession();
    const { api, requests } = setup(() => json({ data: [], total: 0 }), { sessionToken: session });
    assert.equal(await api.getAccountId(), ACC);
    await api.watchlist("pt-BR");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.Authorization, "Bearer " + session.token);
    assert.equal(requests[0].credentials, "include");
  });

  test("sem token do site, pede um com grant_type=etp_rt_cookie", async () => {
    const { api, requests } = setup((url) =>
      url.endsWith("/auth/v1/token")
        ? json({ access_token: "novo", expires_in: 300, account_id: ACC })
        : json({ data: [], total: 0 })
    );
    await api.watchlist("pt-BR");
    const auth = requests[0];
    assert.equal(auth.method, "POST");
    assert.match(auth.url, /\/auth\/v1\/token$/);
    const body = new URLSearchParams(auth.body);
    assert.equal(body.get("grant_type"), "etp_rt_cookie");
    assert.equal(body.get("device_id"), "device-uuid");
    assert.equal(auth.headers.Authorization, "Basic " + btoa("noaihdevm_6iyg0a8l0q:"));
    assert.equal(requests[1].headers.Authorization, "Bearer novo");
    assert.match(requests[1].url, new RegExp(`/content/v2/discover/${ACC}/watchlist`));
  });

  test("token do site expirado é ignorado", async () => {
    const { api, requests } = setup(
      (url) =>
        url.endsWith("/auth/v1/token")
          ? json({ access_token: "novo", account_id: ACC })
          : json({ data: [] }),
      { sessionToken: { token: jwt({ account_id: ACC }), exp: Date.now() - 1000 } }
    );
    await api.watchlist("pt-BR");
    assert.match(requests[0].url, /\/auth\/v1\/token$/);
  });

  test("401 descarta o token, pede outro e repete a chamada uma vez", async () => {
    const session = validSession();
    const { api, requests, browser } = setup(
      (url, init) => {
        if (url.endsWith("/auth/v1/token")) return json({ access_token: "renovado", account_id: ACC });
        return init.headers.Authorization === "Bearer renovado"
          ? json({ data: [{ id: 1 }], total: 1 })
          : json({ error: "expired" }, 401);
      },
      { sessionToken: session }
    );
    const items = await api.watchlist("pt-BR");
    assert.equal(items.length, 1);
    assert.equal(browser.storage.session.data.crToken, undefined);
    assert.deepEqual(
      requests.map((r) => r.url.replace(/\?.*/, "").replace("https://www.crunchyroll.com", "")),
      [`/content/v2/discover/${ACC}/watchlist`, "/auth/v1/token", `/content/v2/discover/${ACC}/watchlist`]
    );
  });

  test("erro de autenticação vira mensagem clara", async () => {
    const browser = fakeBrowser({
      tabs: {
        query: async () => [{ id: 5, status: "complete" }],
        sendMessage: async (id, msg) =>
          msg.type === "crnovos-ping" ? { ok: true } : msg.type === "crnovos-fetch" ? { status: 401, text: "" } : {},
      },
    });
    const { api } = setup(() => json({}, 401), { browser });
    await assert.rejects(api.getAccountId(), /Não consegui autenticar \(HTTP 401\)/);
  });
});

describe("transporte", () => {
  test("bloqueio do Cloudflare troca para a aba do Crunchyroll (ponte)", async () => {
    const sent = [];
    const browser = fakeBrowser({
      tabs: {
        query: async () => [{ id: 7, status: "complete" }],
        sendMessage: async (tabId, msg) => {
          sent.push([tabId, msg.type, msg.req && msg.req.path]);
          if (msg.type === "crnovos-ping") return { ok: true };
          if (msg.type === "crnovos-client-id") return { clientId: "id-da-pagina" };
          return { status: 200, text: JSON.stringify({ data: [], total: 0 }) };
        },
      },
    });
    const notices = [];
    const { api, requests } = setup(
      () => new Response("<title>Just a moment...</title> cloudflare", { status: 403 }),
      { browser, sessionToken: validSession() }
    );
    api.setNoticeHandler((m) => notices.push(m));
    await api.watchlist("pt-BR");

    assert.equal(requests.length, 1, "só a primeira tentativa direta");
    assert.ok(sent.some(([id, type, p]) => id === 7 && type === "crnovos-fetch" && /watchlist/.test(p)));
    assert.match(notices.join(" "), /aba do crunchyroll/i);
  });

  test("sem aba aberta, abre uma em segundo plano e fecha no release()", async () => {
    let created = null;
    const removed = [];
    let browser;
    browser = fakeBrowser({
      tabs: {
        query: async () => [],
        create: async (opts) => {
          created = opts;
          setTimeout(() => browser.tabs.onUpdated.fire(42, { status: "complete" }), 0);
          return { id: 42, status: "loading" };
        },
        remove: async (id) => removed.push(id),
        sendMessage: async (id, msg) =>
          msg.type === "crnovos-ping" ? { ok: true } : { status: 200, text: '{"data":[]}' },
      },
    });
    const { api } = setup(
      () => {
        throw new TypeError("NetworkError");
      },
      { browser, sessionToken: validSession() }
    );
    await api.watchlist("pt-BR");
    assert.equal(created.active, false);
    assert.match(created.url, /^https:\/\/www\.crunchyroll\.com\//);
    await api.release();
    assert.deepEqual(removed, [42]);
  });

  test("aba aberta antes da instalação recebe a ponte via scripting", async () => {
    let injected = null;
    let alive = false;
    const browser = fakeBrowser({
      tabs: {
        query: async () => [{ id: 3, status: "complete" }],
        sendMessage: async (id, msg) => {
          if (msg.type === "crnovos-ping") {
            if (!alive) throw new Error("Could not establish connection");
            return { ok: true };
          }
          return { status: 200, text: '{"data":[]}' };
        },
      },
      scripting: {
        executeScript: async (opts) => {
          injected = opts;
          alive = true;
        },
      },
    });
    const { api } = setup(() => new Response("cloudflare", { status: 403 }), {
      browser,
      sessionToken: validSession(),
    });
    await api.watchlist("pt-BR");
    assert.deepEqual(plain(injected), { target: { tabId: 3 }, files: ["src/bridge.js"] });
  });
});

describe("endpoints", () => {
  test("watchlist pagina de 100 em 100 até o total", async () => {
    const { api, requests } = setup(
      (url) => {
        const start = Number(new URL(url).searchParams.get("start"));
        const count = start === 0 ? 100 : 50;
        return json({ data: Array.from({ length: count }, (_, i) => ({ i: start + i })), total: 150 });
      },
      { sessionToken: validSession() }
    );
    const items = await api.watchlist("pt-BR");
    assert.equal(items.length, 150);
    assert.deepEqual(
      requests.map((r) => new URL(r.url).searchParams.get("start")),
      ["0", "100"]
    );
    const q = new URL(requests[0].url).searchParams;
    assert.equal(q.get("locale"), "pt-BR");
    assert.equal(q.get("order"), "desc");
  });

  test("playheads consulta em lotes de 50 e indexa por content_id", async () => {
    const { api, requests } = setup(
      (url) => {
        const ids = new URL(url).searchParams.get("content_ids").split(",");
        return json({ data: ids.map((id) => ({ content_id: id, playhead: 1 })) });
      },
      { sessionToken: validSession() }
    );
    const ids = Array.from({ length: 120 }, (_, i) => `ep${i}`);
    const map = await api.playheads(ids, "pt-BR");
    assert.equal(map.size, 120);
    assert.equal(map.get("ep119").playhead, 1);
    assert.equal(requests.length, 3);
    assert.match(requests[0].url, new RegExp(`/content/v2/${ACC}/playheads`));
  });

  test("seasons e episodes usam os caminhos do CMS v2", async () => {
    const { api, requests } = setup(() => json({ data: [{ id: "x" }] }), { sessionToken: validSession() });
    assert.deepEqual(plain(await api.seasons("SERIE", "pt-BR")), [{ id: "x" }]);
    await api.episodes("TEMP", "pt-BR");
    assert.match(requests[0].url, /\/content\/v2\/cms\/series\/SERIE\/seasons\?locale=pt-BR$/);
    assert.match(requests[1].url, /\/content\/v2\/cms\/seasons\/TEMP\/episodes\?locale=pt-BR$/);
  });

  test("erro HTTP diferente de 401/403 é propagado com o caminho", async () => {
    const { api } = setup(() => json({}, 500), { sessionToken: validSession() });
    await assert.rejects(api.seasons("S", "pt-BR"), /HTTP 500 em \/content\/v2\/cms\/series\/S\/seasons/);
  });
});

describe("requisições em paralelo", () => {
  test("vários 401 ao mesmo tempo geram um único pedido de token", async () => {
    let tokenRequests = 0;
    const { api } = setup(
      async (url, init) => {
        if (url.endsWith("/auth/v1/token")) {
          tokenRequests++;
          await new Promise((r) => setTimeout(r, 10));
          return json({ access_token: "renovado", account_id: ACC });
        }
        return init.headers.Authorization === "Bearer renovado"
          ? json({ data: [{ ok: true }] })
          : json({ error: "expired" }, 401);
      },
      { sessionToken: validSession() }
    );
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => api.seasons(`S${i}`, "pt-BR")));
    assert.equal(all.length, 8);
    assert.ok(all.every((d) => d.length === 1));
    assert.equal(tokenRequests, 1);
  });

  test("várias requisições pela ponte ao mesmo tempo abrem uma única aba", async () => {
    let created = 0;
    let browser;
    browser = fakeBrowser({
      tabs: {
        query: async () => [],
        create: async () => {
          created++;
          setTimeout(() => browser.tabs.onUpdated.fire(50, { status: "complete" }), 5);
          return { id: 50, status: "loading" };
        },
        sendMessage: async (id, msg) =>
          msg.type === "crnovos-ping" ? { ok: true } : { status: 200, text: '{"data":[]}' },
      },
    });
    const { api } = setup(
      () => {
        throw new TypeError("NetworkError");
      },
      { browser, sessionToken: validSession() }
    );
    await Promise.all(Array.from({ length: 6 }, (_, i) => api.episodes(`T${i}`, "pt-BR")));
    assert.equal(created, 1);
  });
});

test("em segundo plano (sem permissão de abrir abas), não abre aba para a ponte", async () => {
  let created = 0;
  const browser = fakeBrowser({ tabs: { query: async () => [], create: async () => (created++, { id: 1 }) } });
  const { api } = setup(
    () => {
      throw new TypeError("NetworkError");
    },
    { browser, sessionToken: validSession() }
  );
  api.setAllowOpenTab(false);
  await assert.rejects(api.seasons("S", "pt-BR"), /Nenhuma aba do crunchyroll\.com aberta/);
  assert.equal(created, 0);
});

describe("perfis", () => {
  test("o perfil vem do token em uso (claim profile_id)", async () => {
    const { api } = setup(() => json({ data: [] }), { sessionToken: validSession({ account_id: ACC, profile_id: "perfil-site" }) });
    assert.equal(await api.getProfileId(), "perfil-site");
  });

  test("lista os perfis da conta", async () => {
    const { api, requests } = setup(
      () => json({ profiles: [{ profile_id: "p1", profile_name: "Ana" }, { profile_id: "p2", profile_name: "Beto" }] }),
      { sessionToken: validSession() }
    );
    const list = await api.profiles();
    assert.deepEqual(plain(list.map((p) => p.profile_name)), ["Ana", "Beto"]);
    assert.match(requests[0].url, /\/accounts\/v1\/me\/multiprofile$/);
  });

  test("avisa quando o token próprio é de outro perfil que o aberto no site", async () => {
    const browser = fakeBrowser();
    browser.storage.local.data.crSiteProfile = "perfil-site";
    const { api } = setup(
      (url) =>
        url.endsWith("/auth/v1/token")
          ? json({ access_token: jwt({ profile_id: "outro-perfil", exp: 9999999999 }), account_id: ACC })
          : json({ data: [] }),
      { browser }
    );
    const notices = [];
    api.setNoticeHandler((m) => notices.push(m));
    await api.watchlist("pt-BR");
    assert.match(notices.join(" "), /outro perfil/);
  });

  test("não avisa quando o perfil é o mesmo", async () => {
    const browser = fakeBrowser();
    browser.storage.local.data.crSiteProfile = "perfil-site";
    const { api } = setup(
      (url) =>
        url.endsWith("/auth/v1/token")
          ? json({ access_token: jwt({ profile_id: "perfil-site", exp: 9999999999 }), account_id: ACC })
          : json({ data: [] }),
      { browser }
    );
    const notices = [];
    api.setNoticeHandler((m) => notices.push(m));
    await api.watchlist("pt-BR");
    assert.equal(notices.length, 0);
  });
});

describe("HTTP 429 (muitas requisições)", () => {
  const tooMany = (retryAfter) =>
    new Response("{}", { status: 429, headers: retryAfter != null ? { "Retry-After": String(retryAfter) } : {} });

  function setupRetry(responses) {
    let i = 0;
    const r = setup(() => responses[Math.min(i++, responses.length - 1)](), { sessionToken: validSession() });
    const waits = [];
    r.api.setSleep(async (ms) => waits.push(ms));
    const notices = [];
    r.api.setNoticeHandler((m) => notices.push(m));
    return { ...r, waits, notices };
  }

  test("espera o Retry-After e tenta de novo", async () => {
    const { api, waits, notices, requests } = setupRetry([() => tooMany(3), () => json({ data: [{ id: "ok" }] })]);
    const data = await api.seasons("S", "pt-BR");
    assert.equal(data[0].id, "ok");
    assert.equal(requests.length, 2);
    assert.equal(waits.length, 1);
    assert.ok(waits[0] > 2500 && waits[0] <= 3000, `esperou ${waits[0]} ms`);
    assert.match(notices.join(" "), /mais devagar/);
  });

  test("sem Retry-After: 1 s, 2 s, 4 s…", async () => {
    const { api, waits } = setupRetry([() => tooMany(), () => tooMany(), () => tooMany(), () => json({ data: [] })]);
    await api.seasons("S", "pt-BR");
    assert.equal(waits.length, 3);
    assert.ok(waits[0] <= 1000 && waits[0] > 900);
    assert.ok(waits[1] <= 2000 && waits[1] > 1900);
    assert.ok(waits[2] <= 4000 && waits[2] > 3900);
  });

  test("desiste depois de 4 novas tentativas", async () => {
    const { api, requests } = setupRetry([() => tooMany(1)]);
    await assert.rejects(api.seasons("S", "pt-BR"), /HTTP 429/);
    assert.equal(requests.length, 5);
  });

  test("Retry-After como data HTTP e limite de 60 s", () => {
    const { api } = setup(() => json({}), { sessionToken: validSession() });
    const now = Date.UTC(2026, 9, 13, 12, 0, 0);
    assert.equal(api.retryDelayMs(new Date(now + 5000).toUTCString(), 0, now), 5000);
    assert.equal(api.retryDelayMs("120", 0, now), 60000);
    assert.equal(api.retryDelayMs("0", 0, now), 1000, "mínimo de 1 s");
    assert.equal(api.retryDelayMs("lixo", 2, now), 4000, "valor inválido cai no exponencial");
  });

  test("pausa compartilhada: depois do 429, as outras requisições também esperam", async () => {
    let first = true;
    const { api, waits } = setupRetry([
      () => {
        if (first) {
          first = false;
          return tooMany(2);
        }
        return json({ data: [] });
      },
    ]);
    await api.seasons("A", "pt-BR"); // recebe 429, espera ~2 s (simulado), consegue
    assert.equal(waits.length, 1);
    // A espera simulada não avança o relógio: a pausa de 2 s ainda vale, então a
    // próxima requisição (outra série) também tem de esperar antes de sair.
    await api.seasons("B", "pt-BR");
    assert.equal(waits.length, 2, "a segunda requisição respeitou a pausa");
    assert.ok(waits[1] > 1500 && waits[1] <= 2000, `esperou ${waits[1]} ms`);
  });
});

describe("histórico de reprodução (watch-history)", () => {
  test("pagina até next_page vazio e marca como completo", async () => {
    const { api, requests } = setup(
      (url) => {
        const page = Number(new URL(url).searchParams.get("page"));
        return json({
          data: Array.from({ length: page < 3 ? 100 : 40 }, (_, i) => ({ id: `e${page}-${i}`, parent_id: "S" })),
          meta: { next_page: page < 3 ? `/x?page=${page + 1}` : "" },
        });
      },
      { sessionToken: validSession() }
    );
    const h = await api.watchHistory("pt-BR");
    assert.equal(h.entries.length, 240);
    assert.equal(h.complete, true);
    assert.deepEqual(plain(requests.map((r) => new URL(r.url).searchParams.get("page"))), ["1", "2", "3"]);
    assert.match(requests[0].url, new RegExp(`/content/v2/${ACC}/watch-history`));
  });

  test("para no limite de páginas e marca como incompleto", async () => {
    const { api } = setup(
      () => json({ data: Array.from({ length: 100 }, (_, i) => ({ id: `e${i}` })), meta: { next_page: "/mais" } }),
      { sessionToken: validSession() }
    );
    const h = await api.watchHistory("pt-BR", { maxPages: 2 });
    assert.equal(h.entries.length, 200);
    assert.equal(h.complete, false);
  });
});
