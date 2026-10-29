// Compatibilidade entre navegadores. O código comum usa a API do Firefox
// (`browser.*`, com Promises). No Firefox ela já existe e este arquivo não faz nada.
// No Chrome e derivados (Edge, Brave, Opera…), `browser` passa a apontar para
// `chrome.*`, que no Manifest V3 também devolve Promises. A única diferença que
// importa aqui é runtime.onMessage: no Firefox o ouvinte responde devolvendo uma
// Promise; no Chrome é preciso chamar sendResponse e devolver true. O embrulho
// abaixo converte uma coisa na outra.
//
// Carregado antes de todos os outros scripts (segundo plano, página da extensão e
// content script da Crunchyroll).

/* global chrome */
(() => {
  if (typeof globalThis.browser !== "undefined" || typeof globalThis.chrome === "undefined") return;
  const c = globalThis.chrome;
  if (!c.runtime || !c.runtime.onMessage) return;

  const original = c.runtime.onMessage;
  const wrapped = new Map();
  const onMessage = {
    addListener(fn) {
      const w = (msg, sender, sendResponse) => {
        let result;
        try {
          result = fn(msg, sender);
        } catch (err) {
          console.warn("[Watchroll]", err);
          return false;
        }
        if (result && typeof result.then === "function") {
          result.then(
            (value) => sendResponse(value),
            (err) => sendResponse({ error: String((err && err.message) || err) })
          );
          return true; // resposta assíncrona
        }
        if (result !== undefined) sendResponse(result);
        return false;
      };
      wrapped.set(fn, w);
      original.addListener(w);
    },
    removeListener(fn) {
      const w = wrapped.get(fn);
      if (w) original.removeListener(w);
      wrapped.delete(fn);
    },
    hasListener: (fn) => wrapped.has(fn),
  };

  // As funções nativas do Chrome precisam ser chamadas com o próprio objeto como `this`.
  const bindAll = (target, overrides = {}) =>
    new Proxy(target, {
      get(obj, key) {
        if (key in overrides) return overrides[key];
        const value = obj[key];
        return typeof value === "function" ? value.bind(obj) : value;
      },
    });

  const runtime = bindAll(c.runtime, { onMessage });
  globalThis.browser = new Proxy(c, {
    get(obj, key) {
      if (key === "runtime") return runtime;
      return obj[key];
    },
  });
})();
