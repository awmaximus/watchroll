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

/* global browser, CRI18n */
var CRApi = (() => {
  const t = (...a) => CRI18n.t(...a);
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
        reject(new Error(t("errTabTimeout")));
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
      throw new Error(t("errNoTab"));
    }
    if (!tab) {
      onNotice(t("noticeOpeningTab"));
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
    if (!r) throw new Error(t("errTabNoAnswer"));
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
      onNotice(t("noticeSlowDown", Math.ceil(delay / 1000)));
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
    onNotice(t("noticeProxy"));
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
        t("errAuth", r.status)
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

  async function warnIfOtherProfile(token) {
    try {
      const { crSiteProfile } = await browser.storage.local.get("crSiteProfile");
      const mine = profileOf(token);
      if (crSiteProfile && mine && crSiteProfile !== mine) onNotice(t("noticeOtherProfile"));
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
    if (r.status < 200 || r.status >= 300) throw new Error(t("errHttp", r.status, path));
    return r.text ? JSON.parse(r.text) : {};
  }

  // Várias consultas pedem o ID da conta ao mesmo tempo (Fila e histórico em
  // paralelo): uma só descoberta serve a todas.
  let accountIdPromise = null;
  function getAccountId() {
    if (isUuidish(accountId)) return Promise.resolve(accountId);
    if (!accountIdPromise) {
      accountIdPromise = (async () => {
        await getToken();
        if (isUuidish(accountId)) return accountId;
        const me = await get("/accounts/v1/me");
        if (!isUuidish(me.account_id)) throw new Error(t("errAccount"));
        accountId = me.account_id;
        return accountId;
      })().finally(() => {
        accountIdPromise = null;
      });
    }
    return accountIdPromise;
  }

  // ---------- leitura paginada em paralelo ----------
  // A Crunchyroll nem sempre diz quantas páginas existem (o watch-history não traz o
  // total). Então as páginas são pedidas em levas, várias de uma vez, e a leitura
  // para na primeira página que indicar o fim; o que veio depois dela é descartado.
  // A primeira leva tem o número de páginas da leitura anterior (guardado), para
  // acertar tudo numa ida só sem pedir páginas a mais; sem essa informação, usa o
  // limite de consultas simultâneas.
  const HINTS_KEY = "crnovos:pageHints";

  async function pageHint(name) {
    try {
      const all = (await browser.storage.local.get(HINTS_KEY))[HINTS_KEY] || {};
      const n = Number(all[name]);
      return Number.isInteger(n) && n > 0 ? n : 0;
    } catch (_) {
      return 0;
    }
  }
  async function savePageHint(name, pages) {
    try {
      const all = (await browser.storage.local.get(HINTS_KEY))[HINTS_KEY] || {};
      all[name] = pages;
      await browser.storage.local.set({ [HINTS_KEY]: all });
    } catch (_) {}
  }

  /**
   * fetchPage(i) pede a página i (0, 1, 2…); isLast(resposta, registrosAtéAqui) diz se
   * ela é a última. Devolve { responses, complete }: complete=false se parou em
   * maxPages. Uma página que falha antes do fim lança o erro; com partialOk, a
   * leitura termina ali com complete=false e o que já veio é aproveitado.
   * Falhas em páginas depois da última são ignoradas.
   */
  async function readPages(name, fetchPage, isLast, { parallel = 4, maxPages, partialOk = false }) {
    const limit = Math.max(1, Number(parallel) || 1);
    const hint = await pageHint(name);
    const responses = [];
    let count = 0;
    let next = 0;
    let wave = Math.min(maxPages, hint || limit);
    while (next < maxPages) {
      const size = Math.min(wave, maxPages - next);
      const indexes = Array.from({ length: size }, (_, k) => next + k);
      const settled = await mapLimit(indexes, limit, (i) =>
        fetchPage(i).then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error })
        )
      );
      for (const r of settled) {
        if (!r.ok) {
          if (!partialOk || !responses.length) throw r.error;
          return { responses, complete: false };
        }
        responses.push(r.value);
        count += ((r.value && r.value.data) || []).length;
        if (isLast(r.value, count)) {
          savePageHint(name, responses.length);
          return { responses, complete: true };
        }
      }
      next += size;
      wave = limit;
    }
    // Parou no limite (histórico longo): da próxima vez, todas as páginas de uma vez.
    savePageHint(name, responses.length);
    return { responses, complete: false };
  }

  // Executa fn(item) com no máximo `limit` chamadas ao mesmo tempo; resultados na ordem.
  async function mapLimit(list, limit, fn) {
    const out = new Array(list.length);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i], i);
      }
    };
    const n = Math.max(1, Math.min(Number(limit) || 1, list.length));
    await Promise.all(Array.from({ length: n }, worker));
    return out;
  }

  const WATCHLIST_PAGE = 100;
  const WATCHLIST_MAX = 3000;
  async function watchlist(locale, { parallel = 4 } = {}) {
    const acc = await getAccountId();
    const n = WATCHLIST_PAGE;
    const { responses } = await readPages(
      "watchlist",
      (i) => get(`/content/v2/discover/${acc}/watchlist`, { order: "desc", n, start: i * n, locale }),
      (r, count) => (r.data || []).length < n || (typeof r.total === "number" && count >= r.total),
      { parallel, maxPages: WATCHLIST_MAX / n }
    );
    return responses.flatMap((r) => r.data || []);
  }

  const seasons = (seriesId, locale) =>
    get(`/content/v2/cms/series/${seriesId}/seasons`, { locale }).then((r) => r.data || []);

  const episodes = (seasonId, locale) =>
    get(`/content/v2/cms/seasons/${seasonId}/episodes`, { locale }).then((r) => r.data || []);

  // Histórico de reprodução (do perfil do token). complete=false se parou no limite
  // de páginas antes do fim: nesse caso, ausência no histórico não prova nada.
  // Na resposta real, "total" é o tamanho da PÁGINA (100), não do histórico, e o
  // next_page traz um cursor; mesmo assim, page=2, 3… devolvem as páginas seguintes,
  // sem repetir registros (conferido num HAR real em out/2026).
  // Se alguém assistir algo durante a leitura, um registro pode vir repetido entre
  // páginas, mas nenhum se perde (a lista vai do mais recente ao mais antigo).
  async function watchHistory(locale, { pageSize = 100, maxPages = 10, parallel = 4 } = {}) {
    const acc = await getAccountId();
    const { responses, complete } = await readPages(
      "watchHistory",
      (i) => get(`/content/v2/${acc}/watch-history`, { page: i + 1, page_size: pageSize, locale }),
      (r, count) => {
        const next = r.meta && r.meta.next_page;
        return (
          (r.data || []).length < pageSize ||
          next === "" ||
          next === null ||
          (next === undefined && typeof r.total === "number" && count >= r.total)
        );
      },
      { parallel, maxPages, partialOk: true }
    );
    return { entries: responses.flatMap((r) => r.data || []), complete };
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
