"use strict";
// Sincronização das preferências entre aparelhos (storage.sync).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeBrowser, plain } = require("./helpers");

// storage.sync falso, com os limites do Firefox/Chrome (8 KB por item, ~100 KB no total).
function fakeSync({ itemLimit = 8192, totalLimit = 102400 } = {}) {
  const data = {};
  const size = (k, v) => Buffer.byteLength(k) + Buffer.byteLength(JSON.stringify(v));
  return {
    data,
    writes: 0,
    async get(key) {
      if (key == null) return structuredClone(data);
      if (typeof key === "string") return key in data ? { [key]: structuredClone(data[key]) } : {};
      return Object.fromEntries(key.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        if (size(k, v) > itemLimit) throw new Error(`QUOTA_BYTES_PER_ITEM: ${k}`);
      }
      const next = { ...data, ...structuredClone(items) };
      const total = Object.entries(next).reduce((t, [k, v]) => t + size(k, v), 0);
      if (total > totalLimit) throw new Error("QUOTA_BYTES");
      Object.assign(data, structuredClone(items));
      this.writes++;
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

// Um "aparelho": storage.local próprio, storage.sync compartilhado.
function device(sync) {
  const b = fakeBrowser();
  if (sync) b.storage.sync = sync;
  const ctx = load(["src/i18n.js", "src/checker.js"], { browser: b });
  return { b, C: ctx.CRChecker };
}

const KEY = "crnovos:settings";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("sincronização das preferências", () => {
  test("gravar também leva ao sync; outro aparelho recebe", async () => {
    const sync = fakeSync();
    const a = device(sync);
    const s = await a.C.loadSettings();
    s.dubLang = "pt-BR";
    s.seriesModes = { GR1: "dub" };
    await a.C.saveSettings(s);

    const b = device(sync);
    const got = await b.C.loadSettings();
    assert.equal(got.dubLang, "pt-BR");
    assert.deepEqual(plain(got.seriesModes), { GR1: "dub" });
    // e fica na cópia local do outro aparelho
    assert.equal(b.b.storage.local.data[KEY].dubLang, "pt-BR");
  });

  test("estado da tela (aba, filtros, nomes das listas) não é sincronizado", async () => {
    const sync = fakeSync();
    const a = device(sync);
    const s = await a.C.loadSettings();
    Object.assign(s, { tab: "week", listFilter: "L1", genreFilters: ["fantasy"], audioFilter: "dub", listNames: { L1: "X" } });
    await a.C.saveSettings(s);

    const b = device(sync);
    b.b.storage.local.data[KEY] = { tab: "search" };
    b.b.storage.local.data["crnovos:syncedAt"] = 1;
    const got = await b.C.loadSettings();
    assert.equal(got.tab, "search"); // o deste aparelho
    assert.equal(got.listFilter, "");
    assert.deepEqual(plain(got.genreFilters), []);
    const synced = JSON.stringify(sync.data);
    assert.doesNotMatch(synced, /week|Weekend|"L1"/);
  });

  test("preferências grandes são divididas em pedaços de até 8 KB e remontadas", async () => {
    const sync = fakeSync();
    const a = device(sync);
    const s = await a.C.loadSettings();
    for (let i = 0; i < 900; i++) s.seriesModes[`GSERIES${String(i).padStart(4, "0")}`] = i % 2 ? "dub" : "sub";
    s.hidden.G1 = { kind: "untilNew", at: 1, seen: ["ação \"citação\" 日本語 😀"] };
    await a.C.saveSettings(s);
    const meta = sync.data[a.C.SYNC_META];
    assert.ok(meta.n > 1, `pedaços: ${meta.n}`);

    const b = device(sync);
    const got = await b.C.loadSettings();
    assert.equal(Object.keys(got.seriesModes).length, 900);
    assert.deepEqual(plain(got.hidden.G1.seen), ["ação \"citação\" 日本語 😀"]);
  });

  test("encolher remove os pedaços que sobraram", async () => {
    const sync = fakeSync();
    const a = device(sync);
    const s = await a.C.loadSettings();
    for (let i = 0; i < 900; i++) s.seriesModes[`GSERIES${i}`] = "dub";
    await a.C.saveSettings(s);
    const before = sync.data[a.C.SYNC_META].n;
    s.seriesModes = {};
    await a.C.saveSettings(s);
    assert.equal(sync.data[a.C.SYNC_META].n, 1);
    for (let i = 1; i < before; i++) assert.ok(!(a.C.SYNC_PREFIX + i in sync.data));
  });

  test("pedaços ainda chegando (checksum não bate): usa o local e não grava por cima", async () => {
    const sync = fakeSync();
    const a = device(sync);
    const s = await a.C.loadSettings();
    s.dubLang = "ja-JP";
    await a.C.saveSettings(s);
    sync.data[a.C.SYNC_PREFIX + "0"] = sync.data[a.C.SYNC_PREFIX + "0"].replace("ja-JP", "xx-XX");
    const writes = sync.writes;

    const b = device(sync);
    b.b.storage.local.data[KEY] = { dubLang: "es-ES" };
    b.b.storage.local.data["crnovos:syncedAt"] = 1;
    const got = await b.C.loadSettings();
    assert.equal(got.dubLang, "es-ES");
    assert.equal(sync.writes, writes);
  });

  test("vale a versão mais nova: mudança feita sem rede volta ao sync depois", async () => {
    const sync = fakeSync();
    const a = device(sync);
    const s = await a.C.loadSettings();
    s.dubLang = "pt-BR";
    await a.C.saveSettings(s);
    await sleep(5);
    // mudou só no local deste aparelho (o sync falhou na hora)
    a.b.storage.local.data[KEY] = { ...a.b.storage.local.data[KEY], dubLang: "fr-FR" };
    a.b.storage.local.data["crnovos:settingsAt"] = Date.now();
    const again = device(sync); // outro contexto (ex.: o segundo plano) do mesmo aparelho
    again.b.storage.local.data = a.b.storage.local.data;
    again.b.storage.local.get = a.b.storage.local.get;
    again.b.storage.local.set = a.b.storage.local.set;
    assert.equal((await again.C.loadSettings()).dubLang, "fr-FR");
    assert.equal((await device(sync).C.loadSettings()).dubLang, "fr-FR");
  });

  test("primeira sincronização de um aparelho que já tinha preferências: soma modos e ocultas", async () => {
    const sync = fakeSync();
    const a = device(sync);
    const s = await a.C.loadSettings();
    s.seriesModes = { A: "dub", BOTH: "dub" };
    s.hidden = { HA: { kind: "forever", at: 1 } };
    await a.C.saveSettings(s);

    const b = device(sync);
    b.b.storage.local.data[KEY] = { seriesModes: { B: "sub", BOTH: "sub" }, hidden: { HB: { kind: "forever", at: 2 } } };
    const got = await b.C.loadSettings();
    assert.deepEqual(plain(got.seriesModes), { B: "sub", BOTH: "dub", A: "dub" });
    assert.deepEqual(Object.keys(got.hidden).sort(), ["HA", "HB"]);
    // e o resultado somado vai para o sync (o aparelho A também passa a ter tudo)
    const back = await device(sync).C.loadSettings();
    assert.deepEqual(Object.keys(back.seriesModes).sort(), ["A", "B", "BOTH"]);
  });

  test("aparelho que já usava a extensão leva as preferências ao sync vazio", async () => {
    const sync = fakeSync();
    const a = device(sync);
    a.b.storage.local.data[KEY] = { dubLang: "de-DE" };
    await a.C.loadSettings();
    assert.equal((await device(sync).C.loadSettings()).dubLang, "de-DE");
  });

  test("gravar o mesmo de novo não regrava o sync", async () => {
    const sync = fakeSync();
    const a = device(sync);
    const s = await a.C.loadSettings();
    s.dubLang = "it-IT";
    await a.C.saveSettings(s);
    const writes = sync.writes;
    s.tab = "week"; // só estado da tela
    await a.C.saveSettings(s);
    await a.C.saveSettings(s);
    assert.equal(sync.writes, writes);
  });

  test("sync cheio ou com erro: continua funcionando só com o local", async () => {
    const sync = fakeSync({ totalLimit: 500 });
    const a = device(sync);
    const s = await a.C.loadSettings();
    for (let i = 0; i < 200; i++) s.seriesModes[`G${i}`] = "dub";
    await a.C.saveSettings(s);
    assert.equal(Object.keys((await a.C.loadSettings()).seriesModes).length, 200);

    const broken = { get: async () => { throw new Error("off"); }, set: async () => { throw new Error("off"); }, remove: async () => {} };
    const c = device(broken);
    const s2 = await c.C.loadSettings();
    s2.dubLang = "ko-KR";
    await c.C.saveSettings(s2);
    assert.equal((await c.C.loadSettings()).dubLang, "ko-KR");
  });

  test("navegador sem storage.sync: só local, como antes", async () => {
    const a = device(null);
    const s = await a.C.loadSettings();
    s.dubLang = "pt-BR";
    await a.C.saveSettings(s);
    assert.equal((await a.C.loadSettings()).dubLang, "pt-BR");
  });

  test("isSyncChange reconhece só as chaves das preferências no sync", () => {
    const { C } = device(fakeSync());
    assert.equal(C.isSyncChange({ "crnovos:sync:0": {} }, "sync"), true);
    assert.equal(C.isSyncChange({ "crnovos:sync:0": {} }, "local"), false);
    assert.equal(C.isSyncChange({ other: {} }, "sync"), false);
  });

  test("pedaços respeitam o limite em bytes mesmo com acentos, aspas e emoji", () => {
    const { C } = device(fakeSync());
    const text = JSON.stringify({ t: "ação \"x\" 日本 😀\n".repeat(2000) });
    const parts = C.chunkText(text, 1000);
    assert.equal(parts.join(""), text);
    for (const p of parts) assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 1000, Buffer.byteLength(JSON.stringify(p)));
  });
});
