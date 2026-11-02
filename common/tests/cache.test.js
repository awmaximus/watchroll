// Botão "Apagar o cache" (Configurações): o que sai e o que fica.
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeBrowser } = require("./helpers");

describe("apagar o cache", () => {
  test("apaga análises, último resultado, notas e dicas de página; mantém preferências e o 'já visto'", async () => {
    const b = fakeBrowser();
    const keep = {
      "crnovos:settings": { defaultMode: "dub" },
      "crnovos:settingsAt": 1,
      "crnovos:syncedAt": 1,
      "crnovos:seen": { x: 1 },
      "crnovos:releases": { y: 1 },
      outra: 1,
    };
    const drop = {
      "crnovos:v10:cache": { S: {} },
      "crnovos:v9:cache": { S: {} }, // versão antiga que tenha sobrado
      "crnovos:last": { at: 1, results: [] },
      "crnovos:scores": { S: {} },
      "crnovos:ratings": { S: {} },
      "crnovos:pageHints": { watchlist: 300 },
    };
    await b.storage.local.set({ ...keep, ...drop });
    const { CRChecker } = load(["src/checker.js"], { browser: b });
    const removed = await CRChecker.clearCache(b);
    assert.deepEqual([...removed].sort(), Object.keys(drop).sort());
    assert.deepEqual(Object.keys(b.storage.local.data).sort(), Object.keys(keep).sort());
  });

  test("isCacheKey não confunde preferências com cache", () => {
    const { CRChecker } = load(["src/checker.js"], { browser: fakeBrowser() });
    assert.equal(CRChecker.isCacheKey("crnovos:v10:cache"), true);
    assert.equal(CRChecker.isCacheKey("crnovos:settings"), false);
    assert.equal(CRChecker.isCacheKey("crnovos:sync:0"), false);
    assert.equal(CRChecker.isCacheKey("crnovos:seen"), false);
  });
});
