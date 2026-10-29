"use strict";
// compat.js: no Chrome, `browser` passa a ser `chrome` e o runtime.onMessage aceita
// ouvintes que respondem com Promise (estilo Firefox).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ROOT } = require("./helpers");

// Roda só o compat.js, sem o `browser` falso que os outros testes usam.
function load(_files, globals) {
  const ctx = vm.createContext({ console, setTimeout, ...globals });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/compat.js"), "utf8"), ctx, { filename: "src/compat.js" });
  return ctx;
}

function fakeChrome() {
  const listeners = [];
  const runtime = {
    id: "abc",
    getURL(p) {
      if (this !== runtime) throw new TypeError("Illegal invocation");
      return `chrome-extension://abc/${p}`;
    },
    onMessage: { addListener: (fn) => listeners.push(fn), removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1) },
  };
  const storage = { local: { get: async () => ({ ok: 1 }) } };
  return { chrome: { runtime, storage }, listeners };
}

describe("compatibilidade com o Chrome (compat.js)", () => {
  test("no Firefox (browser já existe) não faz nada", () => {
    const browser = { marker: true };
    const ctx = load(["src/compat.js"], { browser, chrome: { runtime: {} } });
    assert.equal(ctx.browser, browser);
  });

  test("no Chrome cria browser = chrome, com as funções ligadas ao objeto certo", async () => {
    const { chrome } = fakeChrome();
    const c2 = load(["src/compat.js"], { chrome });
    assert.equal(c2.browser.runtime.getURL("x.html"), "chrome-extension://abc/x.html");
    assert.deepEqual({ ...(await c2.browser.storage.local.get("k")) }, { ok: 1 });
  });

  test("ouvinte que devolve Promise responde por sendResponse (e mantém o canal aberto)", async () => {
    const { chrome, listeners } = fakeChrome();
    const ctx = load(["src/compat.js"], { chrome });
    ctx.browser.runtime.onMessage.addListener(async (msg) => ({ echo: msg.n }));
    let answer;
    const keepOpen = listeners[0]({ n: 5 }, {}, (v) => (answer = v));
    assert.equal(keepOpen, true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(answer.echo, 5);
  });

  test("ouvinte que não responde (undefined) não prende o canal; erro vira { error }", async () => {
    const { chrome, listeners } = fakeChrome();
    const ctx = load(["src/compat.js"], { chrome });
    ctx.browser.runtime.onMessage.addListener(() => undefined);
    ctx.browser.runtime.onMessage.addListener(() => Promise.reject(new Error("falhou")));
    let called = false;
    assert.equal(listeners[0]({}, {}, () => (called = true)), false);
    assert.equal(called, false);
    let answer;
    assert.equal(listeners[1]({}, {}, (v) => (answer = v)), true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(answer.error, "falhou");
  });
});
