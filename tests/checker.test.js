"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeBrowser, plain } = require("./helpers");

/** browser falso com ícone, notificações, alarmes e eventos registráveis. */
function richBrowser() {
  const b = fakeBrowser();
  const events = () => {
    const ls = [];
    return { addListener: (f) => ls.push(f), fire: (...a) => Promise.all(ls.map((f) => f(...a))), ls };
  };
  b.badge = { text: null, color: null, title: null };
  b.action = {
    setBadgeText: async ({ text }) => (b.badge.text = text),
    setBadgeBackgroundColor: async ({ color }) => (b.badge.color = color),
    setBadgeTextColor: async () => {},
    setTitle: async ({ title }) => (b.badge.title = title),
    onClicked: events(),
  };
  b.notified = [];
  b.notifications = { create: async (id, opts) => b.notified.push({ id, ...opts }), onClicked: events() };
  b.runtime = { getURL: (p) => `moz-extension://x/${p}`, onMessage: events(), onInstalled: events(), onStartup: events() };
  b.alarms = {
    list: new Map(),
    create: async (name, opts) => b.alarms.list.set(name, opts),
    clear: async (name) => b.alarms.list.delete(name),
    onAlarm: events(),
  };
  b.storage.onChanged = events();
  b.tabs.update = async () => {};
  b.windows = { update: async () => {} };
  b.opened = [];
  b.tabs.create = async (o) => (b.opened.push(o.url), { id: 1 });
  return b;
}

const ep = (id, n, extra = {}) => ({ id, number: String(n), season: 1, ...extra });
const pending = (seriesId, title, eps) => ({ seriesId, title, status: "pending", pending: eps });

describe("contagem e ícone", () => {
  const { CRChecker } = load(["src/checker.js"], { browser: richBrowser() });

  test("conta só os episódios pendentes, sem extras nem pulados", () => {
    const results = [
      pending("A", "Série A", [ep("a1", 1), ep("a2", 2), ep("a3", 3, { extra: true }), ep("a0", 0, { skipped: true })]),
      pending("B", "Série B", [ep("b1", 1)]),
      { seriesId: "C", status: "uptodate", pending: [] },
      { seriesId: "D", status: "never", pending: [] },
    ];
    assert.deepEqual(plain(CRChecker.summarize(results)), { episodes: 3, series: 2 });
  });

  test("texto do ícone: vazio, número e 99+", () => {
    assert.equal(CRChecker.badgeText(0), "");
    assert.equal(CRChecker.badgeText(7), "7");
    assert.equal(CRChecker.badgeText(150), "99+");
  });

  test("atualiza número, cor e dica do ícone", async () => {
    const b = richBrowser();
    const { CRChecker: C } = load(["src/checker.js"], { browser: b });
    await C.updateBadge([pending("A", "Série A", [ep("a1", 1), ep("a2", 2)])]);
    assert.equal(b.badge.text, "2");
    assert.equal(b.badge.color, "#ff640a");
    assert.match(b.badge.title, /2 em 1 série/);
    await C.updateBadge([]);
    assert.equal(b.badge.text, "");
    assert.match(b.badge.title, /tudo em dia/);
  });

  test("verificação automática: valores fora da lista voltam ao padrão (60)", () => {
    assert.equal(CRChecker.autoCheckMinutes({ autoCheckMinutes: 0 }), 0);
    assert.equal(CRChecker.autoCheckMinutes({ autoCheckMinutes: 180 }), 180);
    assert.equal(CRChecker.autoCheckMinutes({ autoCheckMinutes: 7 }), 60);
    assert.equal(CRChecker.autoCheckMinutes({}), 60);
  });
});

describe("o que é novo e notificação", () => {
  test("primeira vez só registra; depois notifica só o que não tinha aparecido", async () => {
    const b = richBrowser();
    const { CRChecker } = load(["src/checker.js"], { browser: b });
    const first = [pending("A", "Série A", [ep("a1", 1)])];
    assert.equal((await CRChecker.record(first, { notify: true })).length, 0);
    assert.equal(b.notified.length, 0);

    const second = [pending("A", "Série A", [ep("a1", 1), ep("a2", 2)]), pending("B", "Série B", [ep("b5", 5)])];
    const fresh = await CRChecker.record(second, { notify: true });
    assert.deepEqual(plain(fresh.map((f) => f.key)), ["A:a2", "B:b5"]);
    assert.equal(b.notified.length, 1);
    assert.equal(b.notified[0].title, "2 episódios novos");
    assert.match(b.notified[0].message, /Série A: T1 E2/);
    assert.match(b.notified[0].message, /Série B: T1 E5/);
    assert.match(b.notified[0].iconUrl, /icon-96\.png$/);
  });

  test("o que a página mostrou não vira notificação depois", async () => {
    const b = richBrowser();
    const { CRChecker } = load(["src/checker.js"], { browser: b });
    await CRChecker.record([]); // estado inicial
    const r = [pending("A", "Série A", [ep("a1", 1)])];
    await CRChecker.record(r); // a página exibiu (sem notificar)
    const fresh = await CRChecker.record(r, { notify: true }); // verificação automática depois
    assert.equal(fresh.length, 0);
    assert.equal(b.notified.length, 0);
  });

  test("com a notificação desligada, só atualiza o ícone", async () => {
    const b = richBrowser();
    const { CRChecker } = load(["src/checker.js"], { browser: b });
    await CRChecker.record([]);
    await CRChecker.record([pending("A", "Série A", [ep("a1", 1)])], {
      notify: true,
      settings: { notify: false },
    });
    assert.equal(b.notified.length, 0);
    assert.equal(b.badge.text, "1");
  });

  test("muitas séries: a notificação resume", () => {
    const { CRChecker } = load(["src/checker.js"], { browser: richBrowser() });
    const fresh = Array.from({ length: 6 }, (_, i) => ({
      series: { seriesId: `S${i}`, title: `Série ${i}` },
      ep: ep(`e${i}`, 1),
    }));
    const { title, message } = CRChecker.notificationText(fresh);
    assert.equal(title, "6 episódios novos");
    assert.equal(message.split("\n").length, 5);
    assert.match(message, /\+ 2 série\(s\)$/);
  });
});

describe("segundo plano", () => {
  function background({ settings = {}, run } = {}) {
    const b = richBrowser();
    b.storage.local.data["crnovos:settings"] = settings;
    const calls = { run: 0, release: 0, allowOpenTab: [] };
    const CRAnalyzer = {
      run: async (opts) => {
        calls.run++;
        return run ? run(opts) : [];
      },
    };
    const CRApi = {
      setAllowOpenTab: (v) => calls.allowOpenTab.push(v),
      release: async () => calls.release++,
    };
    const quiet = { ...console, warn: () => {} };
    const ctx = load(["src/checker.js", "src/background.js"], {
      browser: b,
      CRAnalyzer,
      CRApi,
      console: quiet,
      atob,
    });
    return { b, calls, ctx };
  }

  test("na instalação agenda a verificação a cada hora (padrão)", async () => {
    const { b } = background();
    await b.runtime.onInstalled.fire();
    assert.deepEqual(plain(b.alarms.list.get("crnovos-verificacao")), { delayInMinutes: 1, periodInMinutes: 60 });
  });

  test("desligada nas configurações: não agenda", async () => {
    const { b } = background({ settings: { autoCheckMinutes: 0 } });
    await b.runtime.onInstalled.fire();
    assert.equal(b.alarms.list.size, 0);
  });

  test("mudar o intervalo nas configurações reagenda", async () => {
    const { b } = background();
    await b.runtime.onInstalled.fire();
    b.storage.local.data["crnovos:settings"] = { autoCheckMinutes: 180 };
    await b.storage.onChanged.fire(
      { "crnovos:settings": { oldValue: {}, newValue: { autoCheckMinutes: 180 } } },
      "local"
    );
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(b.alarms.list.get("crnovos-verificacao").periodInMinutes, 180);
  });

  test("o alarme verifica sem permitir abrir abas, atualiza o ícone e libera recursos", async () => {
    const { b, calls } = background({ run: () => [pending("A", "Série A", [ep("a1", 1)])] });
    await b.alarms.onAlarm.fire({ name: "crnovos-verificacao" });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.run, 1);
    assert.deepEqual(calls.allowOpenTab, [false]);
    assert.equal(calls.release, 1);
    assert.equal(b.badge.text, "1");
  });

  test("falha na verificação (sem sessão/aba) não quebra nem mexe no ícone", async () => {
    const { b, calls } = background({
      run: () => {
        throw new Error("Nenhuma aba do crunchyroll.com aberta");
      },
    });
    await b.alarms.onAlarm.fire({ name: "crnovos-verificacao" });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.run, 1);
    assert.equal(b.badge.text, null);
    assert.equal(calls.release, 1);
  });

  test("clicar na notificação abre a página da extensão", async () => {
    const { b } = background();
    await b.notifications.onClicked.fire("crnovos-novos");
    assert.deepEqual(b.opened, ["moz-extension://x/dashboard/dashboard.html"]);
  });
});

describe("perfis no registro de novidades", () => {
  test("cada perfil tem seu 'já visto': trocar de perfil não notifica em massa", async () => {
    const b = richBrowser();
    const { CRChecker } = load(["src/checker.js"], { browser: b });
    await CRChecker.record([pending("A", "Série A", [ep("a1", 1)])], { scope: "conta:p1" });
    const fresh = await CRChecker.record([pending("Z", "Série Z", [ep("z1", 1)])], { notify: true, scope: "conta:p2" });
    assert.equal(fresh.length, 0, "primeira vez no perfil 2 só registra");
    assert.equal(b.notified.length, 0);
    const again = await CRChecker.record([pending("A", "Série A", [ep("a1", 1), ep("a2", 2)])], {
      notify: true,
      scope: "conta:p1",
    });
    assert.deepEqual(plain(again.map((f) => f.key)), ["A:a2"]);
  });

  test("formato antigo do 'já visto' (lista simples) continua valendo", async () => {
    const b = richBrowser();
    b.storage.local.data["crnovos:seen"] = ["A:a1"];
    const { CRChecker } = load(["src/checker.js"], { browser: b });
    const fresh = await CRChecker.record([pending("A", "Série A", [ep("a1", 1), ep("a2", 2)])], { notify: true });
    assert.deepEqual(plain(fresh.map((f) => f.key)), ["A:a2"]);
  });
});

test("segundo plano guarda o perfil aberto no site a partir do token capturado", async () => {
  const b = richBrowser();
  const quiet = { ...console, warn: () => {} };
  load(["src/checker.js", "src/background.js"], { browser: b, CRAnalyzer: {}, CRApi: {}, console: quiet, atob });
  const payload = Buffer.from(JSON.stringify({ profile_id: "perfil-site", exp: 9999999999 })).toString("base64url");
  const token = `x.${payload}.y`;
  await b.runtime.onMessage.fire({ type: "crnovos-token", token }, { url: "https://www.crunchyroll.com/pt-br" });
  assert.equal(b.storage.local.data.crSiteProfile, "perfil-site");
  assert.equal(b.storage.session.data.crToken.token, token);
  // De outra origem, ignora.
  await b.runtime.onMessage.fire({ type: "crnovos-token", token: "a.b.c" }, { url: "https://example.com/" });
  assert.equal(b.storage.session.data.crToken.token, token);
});
