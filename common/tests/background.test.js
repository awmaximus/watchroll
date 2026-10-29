"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeBrowser } = require("./helpers");

function setup() {
  const b = fakeBrowser();
  const ls = {};
  const ev = (n) => ({ addListener: (f) => (ls[n] = f) });
  b.action = { onClicked: ev("click") };
  b.notifications = { onClicked: ev("notif") };
  b.alarms = { clear: async () => {}, create: async () => {}, onAlarm: ev("alarm") };
  b.runtime = { ...b.runtime, getURL: (p) => "moz-extension://x/" + p, onMessage: ev("msg"), onInstalled: ev("inst"), onStartup: ev("start") };
  b.storage.onChanged = ev("changed");
  b.tabs = { query: async () => [] };
  load(["src/i18n.js", "src/api.js", "src/analyzer.js", "src/checker.js", "src/background.js"], { browser: b });
  return { b, ls };
}

const B = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = B({ alg: "x" }) + "." + B({ exp: Math.floor(Date.now() / 1000) + 300, profile_id: "p1" }) + ".sig";
const URL_CR = "https://www.crunchyroll.com/pt-br";

describe("token vindo da página", () => {
  for (const [label, token, sender, accepted] of [
    ["JWT de uma aba normal da Crunchyroll", JWT, { url: URL_CR, tab: { incognito: false } }, true],
    ["valor que não é JWT (outro script da página)", "lixo", { url: URL_CR }, false],
    ["aba privativa", JWT, { url: URL_CR, tab: { incognito: true } }, false],
    ["outro site", JWT, { url: "https://example.com/" }, false],
  ]) {
    test(`${label}: ${accepted ? "aceito" : "recusado"}`, async () => {
      const { b, ls } = setup();
      await ls.msg({ type: "crnovos-token", token }, sender);
      assert.equal(!!b.storage.session.data.crToken, accepted);
      assert.equal(b.storage.local.data.crSiteProfile === "p1", accepted);
    });
  }
});
