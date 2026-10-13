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
