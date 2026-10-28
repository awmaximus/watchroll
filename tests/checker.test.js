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
    assert.equal(CRChecker.autoCheckMinutes({ autoCheckMinutes: 7 }), 7, "qualquer número de minutos");
    assert.equal(CRChecker.autoCheckMinutes({ autoCheckMinutes: "45" }), 45);
    assert.equal(CRChecker.autoCheckMinutes({ autoCheckMinutes: 2 }), 5, "mínimo de 5");
    assert.equal(CRChecker.autoCheckMinutes({ autoCheckMinutes: 99999 }), 1440, "máximo de 1 dia");
    assert.equal(CRChecker.autoCheckMinutes({ autoCheckMinutes: -3 }), 60);
    assert.equal(CRChecker.autoCheckMinutes({ autoCheckMinutes: "abc" }), 60);
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

describe("ocultar / adiar série", () => {
  const { CRChecker } = load(["src/checker.js"], { browser: richBrowser() });
  const now = Date.UTC(2026, 9, 13, 12);
  const DAY = 86400000;
  const S = (eps) => pending("S", "Série S", eps);

  test("ocultar sempre", () => {
    const h = CRChecker.makeHide("forever", S([ep("e1", 1)]), now);
    assert.equal(CRChecker.isHidden(S([ep("e1", 1), ep("e2", 2)]), h, now + 365 * DAY), true);
  });

  test("ocultar por 1 semana: volta depois de 7 dias", () => {
    const h = CRChecker.makeHide("week", S([ep("e1", 1)]), now);
    assert.equal(CRChecker.isHidden(S([ep("e1", 1)]), h, now + 6 * DAY), true);
    assert.equal(CRChecker.isHidden(S([ep("e1", 1)]), h, now + 7 * DAY), false);
  });

  test("até sair episódio novo: continua oculta com os mesmos pendentes, volta com um novo", () => {
    const h = CRChecker.makeHide("untilNew", S([ep("e1", 1), ep("e2", 2)]), now);
    assert.equal(CRChecker.isHidden(S([ep("e1", 1), ep("e2", 2)]), h, now), true);
    assert.equal(CRChecker.isHidden(S([ep("e2", 2)]), h, now), true, "viu o 1: continua oculta");
    assert.equal(CRChecker.isHidden({ seriesId: "S", status: "uptodate", pending: [] }, h, now), true);
    assert.equal(CRChecker.isHidden(S([ep("e2", 2), ep("e3", 3)]), h, now), false, "saiu o 3: volta");
  });

  test("até sair episódio novo: especiais e pulados não fazem a série voltar", () => {
    const h = CRChecker.makeHide("untilNew", S([ep("e1", 1)]), now);
    assert.equal(CRChecker.isHidden(S([ep("e1", 1), ep("x", 1.5, { extra: "especial" })]), h, now), true);
    assert.equal(CRChecker.isHidden(S([ep("e1", 1), ep("p", 0, { skipped: true })]), h, now), true);
  });

  test("ocultas não contam no ícone nem geram notificação", async () => {
    const b = richBrowser();
    const { CRChecker: C } = load(["src/checker.js"], { browser: b });
    await C.record([]);
    const results = [pending("A", "Série A", [ep("a1", 1)]), pending("B", "Série B", [ep("b1", 1)])];
    const settings = { notify: true, hidden: { B: { kind: "forever", at: now } } };
    const fresh = await C.record(results, { notify: true, settings });
    assert.deepEqual(plain(fresh.map((f) => f.key)), ["A:a1"]);
    assert.equal(b.badge.text, "1");
    assert.doesNotMatch(b.notified[0].message, /Série B/);
  });

  test("preferências salvas antigas (sem 'hidden') carregam com lista vazia", async () => {
    const b = richBrowser();
    b.storage.local.data["crnovos:settings"] = { defaultMode: "dub" };
    const { CRChecker: C } = load(["src/checker.js"], { browser: b });
    const s = await C.loadSettings();
    assert.deepEqual(plain(s.hidden), {});
    assert.equal(s.defaultMode, "dub");
  });
});

describe("busca e ordenação", () => {
  const { CRChecker } = load(["src/checker.js"], { browser: richBrowser() });

  test("busca ignora acentos e maiúsculas, e exige todas as palavras", () => {
    assert.equal(CRChecker.matchesSearch("Kaguya-sama: Love is War", "kaguya"), true);
    assert.equal(CRChecker.matchesSearch("Não Mais Permitido", "nao mais"), true);
    assert.equal(CRChecker.matchesSearch("Saga of Tanya the Evil", "TANYA evil"), true);
    assert.equal(CRChecker.matchesSearch("Saga of Tanya the Evil", "tanya war"), false);
    assert.equal(CRChecker.matchesSearch("Qualquer", "   "), true);
  });

  const list = [
    { title: "Bravo", lastWatchedAt: 300, pending: [{ availableAt: 10 }] },
    { title: "Alfa", lastWatchedAt: 100, pending: [{ availableAt: 30 }, { availableAt: 5 }, { availableAt: 1, extra: "recap" }] },
    { title: "Charlie", lastWatchedAt: 200, pending: [{ availableAt: 20 }, { availableAt: 21 }, { availableAt: 22 }] },
  ];
  const order = (by) => plain(CRChecker.sortPending(list, by).map((r) => r.title));

  test("lançamento mais recente (padrão)", () => {
    assert.deepEqual(order("released"), ["Alfa", "Charlie", "Bravo"]);
    assert.deepEqual(order("desconhecido"), ["Alfa", "Charlie", "Bravo"]);
  });
  test("visto mais recentemente", () => assert.deepEqual(order("watched"), ["Bravo", "Charlie", "Alfa"]));
  test("mais episódios (sem contar extras)", () => assert.deepEqual(order("count"), ["Charlie", "Alfa", "Bravo"]));
  test("título", () => assert.deepEqual(order("title"), ["Alfa", "Bravo", "Charlie"]));
  test("não altera a lista original", () => {
    CRChecker.sortPending(list, "title");
    assert.equal(list[0].title, "Bravo");
  });
});

describe("ordenação por aba", () => {
  const { CRChecker } = load(["src/i18n.js", "src/checker.js"], { browser: fakeBrowser() });
  const R = (title, extra = {}) => ({ title, pending: [], ...extra });
  const order = (list, by) => plain(CRChecker.sortResults(list, by).map((r) => r.title));

  test("cada aba tem as suas opções; a primeira é a padrão", () => {
    assert.equal(CRChecker.sortFor({}, "never"), "season");
    assert.equal(CRChecker.sortFor({}, "upToDate"), "watched");
    assert.equal(CRChecker.sortFor({ sortByTab: { upToDate: "title" } }, "upToDate"), "title");
    assert.equal(CRChecker.sortFor({ sortByTab: { upToDate: "count" } }, "upToDate"), "watched", "opção de outra aba é ignorada");
    assert.equal(CRChecker.sortFor({ sortBy: "title" }, "toWatch"), "title", "herda a escolha antiga do Para assistir");
    for (const [tab, list] of Object.entries(CRChecker.TAB_SORTS)) {
      for (const k of list) assert.ok(CRChecker.SORTS[k], `${tab}: ${k} tem rótulo`);
    }
  });

  test("visto mais recentemente, esperando, próximo lançamento e temporada de lançamento", () => {
    const list = [
      R("B", { lastWatchedAt: 10, waitingDub: 1, next: { at: 300 }, launch: { season: "spring", year: 2026 } }),
      R("A", { lastWatchedAt: 30, waitingSub: 5, launch: { season: "fall", year: 2026 } }),
      R("C", { lastWatchedAt: 20, waitingDub: 3, next: { at: 100 } }),
    ];
    assert.deepEqual(order(list, "watched"), ["A", "C", "B"]);
    assert.deepEqual(order(list, "waiting"), ["A", "C", "B"]);
    assert.deepEqual(order(list, "next"), ["C", "B", "A"], "sem próximo lançamento vai por último");
    assert.deepEqual(order(list, "season"), ["A", "B", "C"], "sem temporada vai por último");
    assert.deepEqual(order(list, "title"), ["A", "B", "C"]);
  });

  test("A iniciar: mais temporadas e mais episódios; sem a informação vai por último", () => {
    const list = [
      R("B", { stats: { seasons: 1, episodes: 24 } }),
      R("A", { stats: { seasons: 3, episodes: 36 } }),
      R("C", {}),
      R("D", { stats: { seasons: 3, episodes: null } }),
    ];
    assert.deepEqual(order(list, "seasons"), ["A", "D", "B", "C"]);
    assert.deepEqual(order(list, "episodes"), ["A", "B", "C", "D"]);
    assert.deepEqual(plain(CRChecker.TAB_SORTS.never), ["season", "title", "seasons", "episodes"]);
    assert.equal(CRChecker.DEFAULT_SETTINGS.groupNever, true);
  });
});

describe("filtro por lista", () => {
  const { CRChecker: C } = load(["src/checker.js"], { browser: fakeBrowser() });
  test("só vale com mais de uma lista escolhida e se a lista ainda está entre elas", () => {
    assert.equal(C.activeListFilter({ sources: ["watchlist", "L1"], listFilter: "L1" }), "L1");
    assert.equal(C.activeListFilter({ sources: ["watchlist"], listFilter: "watchlist" }), "");
    assert.equal(C.activeListFilter({ sources: ["watchlist", "L2"], listFilter: "L1" }), "");
    assert.equal(C.activeListFilter({ sources: ["watchlist", "L1"], listFilter: "" }), "");
  });
  test("inList: sem filtro passa tudo; resultado antigo (sem lists) conta como Fila", () => {
    assert.equal(C.inList({ lists: ["L1"] }, ""), true);
    assert.equal(C.inList({ lists: ["L1"] }, "L1"), true);
    assert.equal(C.inList({ lists: ["watchlist"] }, "L1"), false);
    assert.equal(C.inList({}, "watchlist"), true);
    assert.equal(C.inList({}, "L1"), false);
  });
  test("preferências: listas padrão e salvas", async () => {
    const b = fakeBrowser();
    const { CRChecker: C2 } = load(["src/checker.js"], { browser: b });
    assert.deepEqual(plain((await C2.loadSettings(b)).sources), ["watchlist"]);
    await C2.saveSettings({ sources: ["L1"], listNames: { L1: "Minha" } }, b);
    const s = await C2.loadSettings(b);
    assert.deepEqual(plain(s.sources), ["L1"]);
    assert.equal(s.listNames.L1, "Minha");
  });
});

describe("alerta na hora do lançamento", () => {
  const { CRChecker: C } = load(["src/checker.js"], { browser: fakeBrowser() });
  const NOW = Date.UTC(2026, 9, 18, 12, 0);
  const MIN = 60000;
  const r = (seriesId, extra = {}) => ({ seriesId, title: seriesId, status: "uptodate", pending: [], ...extra });

  test("agenda 3 minutos depois do próximo lançamento conhecido", () => {
    const { when, watch } = C.planReleases(
      [r("A", { next: { id: "a2", at: NOW + 60 * MIN } }), r("B", { next: { id: "b9", at: NOW + 20 * MIN } }), r("C")],
      [],
      { hidden: {} },
      NOW
    );
    assert.equal(when, NOW + 23 * MIN);
    assert.deepEqual(plain(watch.map((e) => e.id).sort()), ["a2", "b9"]);
  });

  test("lançamento atrasado (já passou e não apareceu): confere de novo em 10 minutos", () => {
    const prev = [{ seriesId: "A", id: "a2", at: NOW - 5 * MIN }];
    const { when, watch } = C.planReleases([r("A")], prev, { hidden: {} }, NOW);
    assert.equal(when, NOW + 10 * MIN);
    assert.equal(watch.length, 1);
  });

  test("para de acompanhar quando o episódio aparece, após 3 horas ou se a série saiu", () => {
    const out = C.planReleases([r("A", { status: "pending", pending: [{ id: "a2" }] })], [{ seriesId: "A", id: "a2", at: NOW - MIN }], { hidden: {} }, NOW);
    assert.equal(out.when, null);
    assert.equal(out.watch.length, 0);
    assert.equal(C.planReleases([r("A")], [{ seriesId: "A", id: "a2", at: NOW - 4 * 3600000 }], { hidden: {} }, NOW).when, null);
    assert.equal(C.planReleases([], [{ seriesId: "A", id: "a2", at: NOW - MIN }], { hidden: {} }, NOW).when, null);
  });

  test("previsão pelo ritmo semanal: para quando a série já aponta o lançamento seguinte", () => {
    const prev = [{ seriesId: "A", id: "est:S1:5", at: NOW - 20 * MIN }];
    const next = { id: "est:S1:6", at: NOW + 7 * 24 * 60 * MIN, estimated: true };
    const out = C.planReleases([r("A", { status: "pending", pending: [{ id: "real5" }], next })], prev, { hidden: {} }, NOW);
    assert.deepEqual(plain(out.watch.map((e) => e.id)), ["est:S1:6"]);
    assert.equal(out.when, next.at + 3 * MIN);
  });

  test("séries ocultas não geram alerta", () => {
    const { when } = C.planReleases([r("A", { next: { id: "a2", at: NOW + MIN * 30 } })], [], { hidden: { A: { kind: "forever" } } }, NOW);
    assert.equal(when, null);
  });

  test("nunca agenda para menos de 1 minuto no futuro", () => {
    const { when } = C.planReleases([r("A", { next: { id: "a2", at: NOW + 1000 } })], [], { hidden: {} }, NOW - 3 * MIN);
    assert.ok(when >= NOW - 2 * MIN);
  });

  test("respeita a notificação e a verificação automática desligadas", async () => {
    const b = fakeBrowser();
    const { CRChecker: C2 } = load(["src/checker.js"], { browser: b });
    const res = [r("A", { next: { id: "a2", at: NOW + 30 * MIN } })];
    assert.equal(await C2.nextReleaseCheck(res, { hidden: {}, notify: true, autoCheckMinutes: 60 }, { b, now: NOW }), NOW + 33 * MIN);
    assert.equal(await C2.nextReleaseCheck(res, { hidden: {}, notify: false, autoCheckMinutes: 60 }, { b, now: NOW }), null);
    assert.equal(await C2.nextReleaseCheck(res, { hidden: {}, notify: true, autoCheckMinutes: 0 }, { b, now: NOW }), null);
  });
});
