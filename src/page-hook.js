// Roda no contexto da própria página (world: MAIN), antes do app da Crunchyroll.
// Observa as requisições que o site faz e repassa o token "Bearer" que ele usa,
// para a extensão poder chamar a mesma API com a sua sessão.
// Nada é enviado para fora: o token só vai para o content script, via evento DOM.
(() => {
  const EVENT = "crnovos:token";
  let last = null;

  function report(value) {
    if (typeof value !== "string") return;
    const m = value.match(/^Bearer\s+(.+)$/i);
    if (!m || m[1] === last) return;
    last = m[1];
    document.dispatchEvent(new CustomEvent(EVENT, { detail: last }));
  }

  function fromHeaders(headers) {
    if (!headers) return;
    try {
      if (headers instanceof Headers) {
        report(headers.get("authorization"));
      } else if (Array.isArray(headers)) {
        for (const [k, v] of headers) if (/^authorization$/i.test(k)) report(v);
      } else if (typeof headers === "object") {
        for (const k of Object.keys(headers)) if (/^authorization$/i.test(k)) report(headers[k]);
      }
    } catch (_) {}
  }

  const isCrunchy = (url) => {
    try {
      return new URL(url, location.href).hostname.endsWith("crunchyroll.com");
    } catch (_) {
      return false;
    }
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (isCrunchy(url)) {
        if (input instanceof Request) fromHeaders(input.headers);
        if (init) fromHeaders(init.headers);
      }
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__crnovosUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (/^authorization$/i.test(name) && isCrunchy(this.__crnovosUrl)) report(value);
    } catch (_) {}
    return origSet.apply(this, arguments);
  };

  // O content script pode pedir o último token visto (caso tenha carregado depois).
  document.addEventListener("crnovos:ask-token", () => {
    if (last) document.dispatchEvent(new CustomEvent(EVENT, { detail: last }));
  });
})();
