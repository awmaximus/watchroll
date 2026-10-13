// Content script invisível em crunchyroll.com. NÃO altera a página.
//  1. Repassa ao background o token que page-hook.js viu o site usar.
//  2. Serve de "ponte": quando a página da extensão não consegue falar com a API
//     diretamente (Cloudflare, cookies), ela pede para esta aba fazer a requisição
//     como se fosse o próprio site (content.fetch = mesma origem e cookies do site).

/* global browser */
(() => {
  if (window.__crnovosBridge) return; // pode ser injetado de novo via scripting
  window.__crnovosBridge = true;

  document.addEventListener("crnovos:token", (e) => {
    const token = String(e.detail || "");
    if (token) browser.runtime.sendMessage({ type: "crnovos-token", token }).catch(() => {});
  });
  document.dispatchEvent(new CustomEvent("crnovos:ask-token"));

  const pageFetch =
    typeof globalThis.content !== "undefined" && globalThis.content && globalThis.content.fetch
      ? globalThis.content.fetch.bind(globalThis.content)
      : fetch.bind(globalThis);

  function readWebClientId() {
    for (const s of document.querySelectorAll("script:not([src])")) {
      const m = s.textContent.match(/"accountAuthClientId"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return null;
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "crnovos-ping") return Promise.resolve({ ok: true });

    if (msg.type === "crnovos-client-id") return Promise.resolve({ clientId: readWebClientId() });

    if (msg.type === "crnovos-fetch") {
      const req = msg.req || {};
      // Só caminhos relativos da própria Crunchyroll.
      if (typeof req.path !== "string" || !req.path.startsWith("/")) {
        return Promise.resolve({ error: "caminho inválido" });
      }
      return pageFetch(location.origin + req.path, {
        method: req.method || "GET",
        credentials: "include",
        headers: req.headers || {},
        body: req.body || undefined,
      })
        .then(async (res) => ({ status: res.status, text: await res.text() }))
        .catch((err) => ({ error: String(err && err.message ? err.message : err) }));
    }
  });
})();
