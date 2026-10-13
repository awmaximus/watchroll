// Acesso à API (não documentada) da Crunchyroll a partir da página da extensão,
// usando a sessão que você já tem aberta no navegador.
//
// Transporte (como a requisição sai):
//  - "direct": fetch da própria página da extensão (cookies do site vão junto
//    graças à permissão de host).
//  - "proxy": se o direto for barrado (Cloudflare, cookie não enviado), a
//    requisição é feita por uma aba do crunchyroll.com via src/bridge.js.
//    Se não houver aba aberta, uma é aberta em segundo plano e fechada no fim.
//
// Token (nesta ordem):
//  1. o último token que o próprio site usou (capturado por page-hook.js);
//  2. um token novo via /auth/v1/token com grant_type=etp_rt_cookie, como o site faz.
//
// Endpoints conferidos no crunchyroll-rs 0.19.1 (set/2026).

/* global browser */
var CRApi = (() => {
  const BASE = "https://www.crunchyroll.com";
  const FALLBACK_WEB_CLIENT_ID = "noaihdevm_6iyg0a8l0q";

  let transport = "direct";
  let proxyTabId = null;
  let openedTabId = null;
  let token = null; // { value, exp }
  let accountId = null;
  let onNotice = () => {};
  // Em segundo plano a extensão não deve abrir abas sozinha.
  let allowOpenTab = true;

  // ---------- JWT ----------
  function jwtPayload(t) {
    try {
      return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    } catch (_) {
      return null;
    }
  }
  const isUuidish = (s) => typeof s === "string" && /^[0-9a-f-]{20,}$/i.test(s);
  const fresh = (t) => t && t.exp - Date.now() > 30 * 1000;

  // ---------- transporte ----------
  async function directSend(req) {
    const res = await fetch(BASE + req.path, {
      method: req.method || "GET",
      credentials: "include",
      headers: req.headers || {},
      body: req.body,
    });
    return { status: res.status, text: await res.text() };
  }

  const looksBlocked = (r) =>
    r.status === 403 && /cloudflare|just a moment|cf-chl|challenge/i.test(r.text || "");

  async function findCrTab() {
    const tabs = await browser.tabs.query({ url: "https://www.crunchyroll.com/*" });
    return tabs.find((t) => t.status === "complete") || tabs[0] || null;
  }

  async function bridgeAlive(tabId) {
    try {
      const r = await browser.tabs.sendMessage(tabId, { type: "crnovos-ping" });
      return !!(r && r.ok);
    } catch (_) {
      return false;
    }
  }

  function waitComplete(tabId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        browser.tabs.onUpdated.removeListener(listener);
        reject(new Error("A aba do Crunchyroll demorou demais para carregar."));
      }, timeoutMs);
      function listener(id, info) {
        if (id === tabId && info.status === "complete") {
          clearTimeout(timer);
          browser.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      browser.tabs.onUpdated.addListener(listener);
    });
  }

  // Várias requisições em paralelo podem pedir a aba ao mesmo tempo: todas
  // esperam o mesmo preparo, em vez de cada uma abrir a sua.
  let proxyTabPromise = null;
  function ensureProxyTab() {
    if (!proxyTabPromise) {
      proxyTabPromise = prepareProxyTab().finally(() => {
        proxyTabPromise = null;
      });
    }
    return proxyTabPromise;
  }

  async function prepareProxyTab() {
    if (proxyTabId != null && (await bridgeAlive(proxyTabId))) return proxyTabId;

    let tab = await findCrTab();
    if (!tab && !allowOpenTab) {
      throw new Error("Nenhuma aba do crunchyroll.com aberta para usar a sua sessão.");
    }
    if (!tab) {
      onNotice("Abrindo crunchyroll.com em segundo plano para usar sua sessão…");
      tab = await browser.tabs.create({ url: BASE + "/", active: false });
      openedTabId = tab.id;
      await waitComplete(tab.id);
    }
    if (!(await bridgeAlive(tab.id))) {
      // Aba aberta antes de instalar a extensão: injeta a ponte agora.
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["src/bridge.js"],
      });
    }
    proxyTabId = tab.id;
    return proxyTabId;
  }

  async function proxySend(req) {
    const tabId = await ensureProxyTab();
    const r = await browser.tabs.sendMessage(tabId, { type: "crnovos-fetch", req });
    if (!r) throw new Error("A aba do Crunchyroll não respondeu.");
    if (r.error) throw new Error(r.error);
    return r;
  }

  async function send(req) {
    if (transport === "direct") {
      try {
        const r = await directSend(req);
        if (!looksBlocked(r)) return r;
      } catch (_) {}
      switchToProxy();
    }
    return proxySend(req);
  }

  function switchToProxy() {
    if (transport === "proxy") return;
    transport = "proxy";
    onNotice("Acesso direto bloqueado; usando uma aba do crunchyroll.com.");
  }

  // ---------- autenticação ----------
  async function clientId() {
    try {
      const tab = transport === "proxy" ? { id: await ensureProxyTab() } : await findCrTab();
      if (tab && (await bridgeAlive(tab.id))) {
        const r = await browser.tabs.sendMessage(tab.id, { type: "crnovos-client-id" });
        if (r && r.clientId) return r.clientId;
      }
    } catch (_) {}
    return FALLBACK_WEB_CLIENT_ID;
  }

  async function deviceId() {
    const { crnovosDeviceId } = await browser.storage.local.get("crnovosDeviceId");
    if (crnovosDeviceId) return crnovosDeviceId;
    const id = crypto.randomUUID();
    await browser.storage.local.set({ crnovosDeviceId: id });
    return id;
  }

  // Com várias séries em paralelo, um token vencido gera vários 401 de uma vez:
  // todos aguardam o mesmo pedido de token.
  let tokenPromise = null;
  function requestOwnToken() {
    if (!tokenPromise) {
      tokenPromise = fetchOwnToken().finally(() => {
        tokenPromise = null;
      });
    }
    return tokenPromise;
  }

  async function fetchOwnToken() {
    const body = new URLSearchParams({
      grant_type: "etp_rt_cookie",
      device_id: await deviceId(),
      device_type: "Firefox",
    }).toString();
    const req = {
      method: "POST",
      path: "/auth/v1/token",
      headers: {
        Authorization: "Basic " + btoa((await clientId()) + ":"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    };
    let r = await send(req);
    if (r.status !== 200 && transport === "direct") {
      // Direto o cookie de sessão pode não ter ido; tenta pela aba.
      switchToProxy();
      req.headers.Authorization = "Basic " + btoa((await clientId()) + ":");
      r = await send(req);
    }
    if (r.status !== 200) {
      throw new Error(
        `Não consegui autenticar (HTTP ${r.status}). Confira se você está logado em crunchyroll.com.`
      );
    }
    const data = JSON.parse(r.text);
    token = { value: data.access_token, exp: Date.now() + (data.expires_in || 300) * 1000 };
    if (isUuidish(data.account_id)) accountId = data.account_id;
    return token.value;
  }

  async function getToken({ forceNew = false } = {}) {
    if (!forceNew && fresh(token)) return token.value;
    if (!forceNew) {
      const { crToken } = await browser.storage.session.get("crToken");
      if (crToken && crToken.exp - Date.now() > 30 * 1000) {
        token = { value: crToken.token, exp: crToken.exp };
        const p = jwtPayload(crToken.token) || {};
        const acc = p.account_id || p.sub;
        if (isUuidish(acc)) accountId = acc;
        return token.value;
      }
    }
    return requestOwnToken();
  }

  // ---------- requisições ----------
  async function get(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const full = qs ? `${path}?${qs}` : path;

    const sentWith = await getToken();
    let r = await send({ path: full, headers: { Authorization: "Bearer " + sentWith } });
    if (r.status === 401 || r.status === 403) {
      const rejected = sentWith;
      let retryToken;
      if (token && token.value !== rejected && fresh(token)) {
        retryToken = token.value; // outra série já renovou o token
      } else {
        token = null;
        await browser.storage.session.remove("crToken");
        retryToken = await getToken({ forceNew: true });
      }
      r = await send({ path: full, headers: { Authorization: "Bearer " + retryToken } });
    }
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} em ${path}`);
    return r.text ? JSON.parse(r.text) : {};
  }

  async function getAccountId() {
    if (isUuidish(accountId)) return accountId;
    await getToken();
    if (isUuidish(accountId)) return accountId;
    const me = await get("/accounts/v1/me");
    if (!isUuidish(me.account_id)) throw new Error("Não consegui descobrir o ID da sua conta.");
    accountId = me.account_id;
    return accountId;
  }

  async function watchlist(locale) {
    const acc = await getAccountId();
    const items = [];
    const n = 100;
    for (let start = 0; start < 3000; start += n) {
      const page = await get(`/content/v2/discover/${acc}/watchlist`, { order: "desc", n, start, locale });
      const data = page.data || [];
      items.push(...data);
      if (data.length < n || items.length >= (page.total || 0)) break;
    }
    return items;
  }

  const seasons = (seriesId, locale) =>
    get(`/content/v2/cms/series/${seriesId}/seasons`, { locale }).then((r) => r.data || []);

  const episodes = (seasonId, locale) =>
    get(`/content/v2/cms/seasons/${seasonId}/episodes`, { locale }).then((r) => r.data || []);

  async function playheads(ids, locale) {
    const acc = await getAccountId();
    const out = new Map();
    for (let i = 0; i < ids.length; i += 50) {
      const r = await get(`/content/v2/${acc}/playheads`, {
        content_ids: ids.slice(i, i + 50).join(","),
        locale,
      });
      for (const p of r.data || []) out.set(p.content_id, p);
    }
    return out;
  }

  // Fecha a aba que nós mesmos abrimos (se abrimos).
  async function release() {
    if (openedTabId != null) {
      try {
        await browser.tabs.remove(openedTabId);
      } catch (_) {}
      if (proxyTabId === openedTabId) proxyTabId = null;
      openedTabId = null;
    }
  }

  return {
    setNoticeHandler: (fn) => (onNotice = fn),
    setAllowOpenTab: (v) => (allowOpenTab = !!v),
    getAccountId,
    watchlist,
    seasons,
    episodes,
    playheads,
    release,
  };
})();
