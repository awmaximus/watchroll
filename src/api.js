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
    return { status: res.status, text: await res.text(), retryAfter: res.headers.get("retry-after") };
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

  // ---------- HTTP 429: espera e tenta de novo ----------
  // A pausa é compartilhada: com várias séries em paralelo, todas esperam juntas.
  const RETRY = { attempts: 4, maxWaitMs: 60000 };
  let cooldownUntil = 0;
  let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function retryDelayMs(retryAfter, attempt, now = Date.now()) {
    let ms = NaN;
    if (retryAfter != null && String(retryAfter).trim() !== "") {
      const v = String(retryAfter).trim();
      ms = /^\d+(\.\d+)?$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
    }
    if (!Number.isFinite(ms) || ms < 0) ms = 1000 * 2 ** attempt; // 1 s, 2 s, 4 s, 8 s
    return Math.min(RETRY.maxWaitMs, Math.max(1000, ms));
  }

  async function send(req) {
    for (let attempt = 0; ; attempt++) {
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const r = await sendOnce(req);
      if (r.status !== 429 || attempt >= RETRY.attempts) return r;
      const delay = retryDelayMs(r.retryAfter, attempt);
      cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
      onNotice(`A Crunchyroll pediu para ir mais devagar; tentando de novo em ${Math.ceil(delay / 1000)} s…`);
    }
  }

  async function sendOnce(req) {
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
    await warnIfOtherProfile(token.value);
    return token.value;
  }

  // ---------- perfis ----------
  // O perfil vem do token (claim profile_id). O token capturado do site é o do perfil
  // aberto no navegador; o background guarda esse perfil em crSiteProfile.
  const profileOf = (t) => {
    const p = (t && jwtPayload(t)) || {};
    return typeof p.profile_id === "string" ? p.profile_id : "";
  };

  async function warnIfOtherProfile(t) {
    try {
      const { crSiteProfile } = await browser.storage.local.get("crSiteProfile");
      const mine = profileOf(t);
      if (crSiteProfile && mine && crSiteProfile !== mine) {
        onNotice(
          "A sessão usada agora é de outro perfil da conta. Abra crunchyroll.com no perfil que você usa e clique em Atualizar."
        );
      }
    } catch (_) {}
  }

  async function getProfileId() {
    return profileOf(await getToken());
  }

  async function profiles() {
    const r = await get("/accounts/v1/me/multiprofile");
    return Array.isArray(r.profiles) ? r.profiles : [];
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

  // Histórico de reprodução (do perfil do token). complete=false se parou no limite
  // de páginas antes do fim: nesse caso, ausência no histórico não prova nada.
  async function watchHistory(locale, { pageSize = 100, maxPages = 10 } = {}) {
    const acc = await getAccountId();
    const entries = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await get(`/content/v2/${acc}/watch-history`, { page, page_size: pageSize, locale });
      const data = r.data || [];
      entries.push(...data);
      const next = r.meta && r.meta.next_page;
      const done =
        data.length < pageSize ||
        next === "" ||
        next === null ||
        (next === undefined && typeof r.total === "number" && entries.length >= r.total);
      if (done) return { entries, complete: true };
    }
    return { entries, complete: false };
  }

  async function movieListing(id, locale) {
    const r = await get(`/content/v2/cms/movie_listings/${id}`, { locale });
    return (r.data || [])[0] || null;
  }

  const movies = (listingId, locale) =>
    get(`/content/v2/cms/movie_listings/${listingId}/movies`, { locale }).then((r) => r.data || []);

  // ---------- playheads em lote ----------
  // Pedidos de várias séries são acumulados por alguns milissegundos e enviados
  // juntos, em lotes de até 50 IDs; cada chamador recebe só os seus.
  const BATCH = { size: 50, windowMs: 10 };
  let phQueue = [];
  let phTimer = null;

  function playheads(ids, locale) {
    const unique = [...new Set(ids)];
    if (!unique.length) return Promise.resolve(new Map());
    return new Promise((resolve, reject) => {
      phQueue.push({ ids: unique, locale, resolve, reject });
      const queued = new Set(phQueue.flatMap((q) => q.ids)).size;
      if (queued >= BATCH.size) flushPlayheads();
      else if (!phTimer) phTimer = setTimeout(flushPlayheads, BATCH.windowMs);
    });
  }

  async function flushPlayheads() {
    clearTimeout(phTimer);
    phTimer = null;
    const batch = phQueue;
    phQueue = [];
    if (!batch.length) return;
    const all = [...new Set(batch.flatMap((b) => b.ids))];
    try {
      const acc = await getAccountId();
      const found = new Map();
      for (let i = 0; i < all.length; i += BATCH.size) {
        const r = await get(`/content/v2/${acc}/playheads`, {
          content_ids: all.slice(i, i + BATCH.size).join(","),
          locale: batch[0].locale,
        });
        for (const p of r.data || []) found.set(p.content_id, p);
      }
      for (const b of batch) {
        b.resolve(new Map(b.ids.filter((id) => found.has(id)).map((id) => [id, found.get(id)])));
      }
    } catch (err) {
      for (const b of batch) b.reject(err);
    }
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
    retryDelayMs,
    // Para testes: troca a espera por uma função instantânea.
    setSleep: (fn) => (sleep = fn),
    getAccountId,
    getProfileId,
    profiles,
    watchlist,
    watchHistory,
    seasons,
    episodes,
    movieListing,
    movies,
    playheads,
    release,
  };
})();
