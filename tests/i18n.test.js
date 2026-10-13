"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load, fakeI18n, readMessages, plain, ROOT } = require("./helpers");

const LOCALES = fs.readdirSync(path.join(ROOT, "_locales"));
const pt = readMessages("pt_BR");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const placeholders = (entry) => (entry.message.match(/\$[A-Za-z0-9_@]+\$/g) || []).sort();
const CODE = ["src/i18n.js", "src/api.js", "src/analyzer.js", "src/checker.js", "src/background.js", "dashboard/dashboard.js"];

describe("arquivos de tradução", () => {
  test("existem pt_BR (padrão do manifesto) e en", () => {
    assert.ok(LOCALES.includes("pt_BR"));
    assert.ok(LOCALES.includes("en"));
    assert.equal(JSON.parse(read("manifest.json")).default_locale, "pt_BR");
  });

  for (const folder of LOCALES) {
    test(`${folder}: mesmas chaves e mesmos marcadores do pt_BR`, () => {
      const other = readMessages(folder);
      assert.deepEqual(Object.keys(other).sort(), Object.keys(pt).sort());
      for (const key of Object.keys(pt)) {
        assert.deepEqual(placeholders(other[key]), placeholders(pt[key]), key);
        assert.ok(other[key].message.trim(), `${folder}/${key} vazio`);
      }
    });

    test(`${folder}: todo marcador usado na mensagem está declarado`, () => {
      for (const [key, entry] of Object.entries(readMessages(folder))) {
        for (const ph of placeholders(entry)) {
          const name = ph.slice(1, -1).toLowerCase();
          assert.ok(entry.placeholders && entry.placeholders[name], `${folder}/${key}: ${ph}`);
        }
      }
    });
  }

  test("plurais têm as duas formas (_one e _other)", () => {
    for (const key of Object.keys(pt)) {
      const m = key.match(/^(.*)_(one|other)$/);
      if (m) assert.ok(pt[`${m[1]}_one`] && pt[`${m[1]}_other`], key);
    }
  });

  test("toda chave usada no código existe (t, tn, __MSG_ e data-i18n)", () => {
    const used = new Set();
    const code = (f) =>
      read(f)
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
        .join("\n");
    for (const f of CODE) {
      for (const m of code(f).matchAll(/\bt\("([A-Za-z0-9_]+)"/g)) used.add(m[1]);
      for (const m of code(f).matchAll(/\btn\("([A-Za-z0-9_]+)"/g)) {
        used.add(`${m[1]}_one`);
        used.add(`${m[1]}_other`);
      }
    }
    for (const m of read("manifest.json").matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);
    for (const m of read("dashboard/dashboard.html").matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
    // As ordenações guardam a chave do rótulo.
    const { CRChecker } = load(["src/checker.js"]);
    for (const key of Object.values(CRChecker.SORTS)) used.add(key);
    const missing = [...used].filter((k) => !(k in pt));
    assert.deepEqual(missing, []);
    assert.ok(used.size > 80, `só ${used.size} chaves encontradas: a busca no código quebrou?`);
  });

  test("a página não tem texto fixo em português fora das traduções", () => {
    const html = read("dashboard/dashboard.html").replace(/<script[\s\S]*?<\/script>/g, "");
    const visible = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    assert.equal(visible, "");
    assert.doesNotMatch(html, /(?<![-\w])(placeholder|aria-label|title)="[^"]*[A-Za-zÀ-ú]{3}/);
    // No JS da página, só comentários e o nome da extensão nos logs podem ter acento.
    const code = read("dashboard/dashboard.js")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l) && !/console\.(error|warn)/.test(l))
      .join("\n")
      .replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /["`'][^"`'\n]*[áéíóúãõçâêôà][^"`'\n]*["`']/);
  });

  test("nenhuma mensagem em português aparece escrita direto no código", () => {
    const texts = Object.values(pt)
      .map((e) => e.message)
      .filter((m) => !m.includes("$") && m.length > 3)
      .filter((m) => !["recap", "especial"].includes(m)); // também são valores internos (tipo de extra)
    for (const f of CODE.filter((f) => f !== "src/i18n.js")) {
      const src = read(f).replace(/\/\/.*$/gm, "");
      for (const m of texts) {
        for (const q of ['"', "`", "'"]) assert.ok(!src.includes(q + m + q), `${f}: ${q}${m}${q}`);
      }
    }
  });

  test("os textos de erro e aviso da API não ficam fixos em português", () => {
    const code = read("src/api.js")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .join("\n")
      .replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /["`][^"`\n]*[áéíóúãõçâêô][^"`\n]*["`]/);
  });
});

describe("CRI18n", () => {
  test("preenche os marcadores na ordem", () => {
    const { CRI18n } = load([]);
    assert.equal(CRI18n.t("progressChecking", 3, 10), "Verificando 3 de 10 séries…");
    assert.equal(CRI18n.t("noteNoDub_other", 4, "pt-BR"), "Temporada atual sem dublagem pt-BR · 4 episódios legendados para ver");
  });

  test("plural escolhe a forma certa", () => {
    const { CRI18n } = load([]);
    assert.equal(CRI18n.tn("badgeNew", 1), "1 novo");
    assert.equal(CRI18n.tn("badgeNew", 3), "3 novos");
    assert.equal(CRI18n.tn("epsCount", 0), "0 episódios");
  });

  test("em inglês", () => {
    const { CRI18n } = load([], { browser: { i18n: fakeI18n("en", "en-US") } });
    assert.equal(CRI18n.t("progressChecking", 3, 10), "Checking 3 of 10 series…");
    assert.equal(CRI18n.tn("badgeNew", 2), "2 new");
    assert.equal(CRI18n.tn("epsCount", 1), "1 episode");
    assert.equal(CRI18n.langName("pt-BR"), "Brazilian Portuguese");
  });

  test("nome do idioma na língua da interface", () => {
    const { CRI18n } = load([]);
    assert.equal(CRI18n.langName("ja-JP"), "Japonês (Japão)");
    assert.equal(CRI18n.langName("xx-invalid!"), "xx-invalid!");
  });

  test("chave desconhecida volta a própria chave (nunca texto vazio)", () => {
    const { CRI18n } = load([]);
    assert.equal(CRI18n.t("naoExiste"), "naoExiste");
  });

  test("ícone e notificação em inglês", async () => {
    const calls = {};
    const browser = {
      i18n: fakeI18n("en", "en-US"),
      action: {
        setBadgeText: async (o) => (calls.text = o.text),
        setBadgeBackgroundColor: async () => {},
        setTitle: async (o) => (calls.title = o.title),
      },
    };
    const { CRChecker } = load(["src/checker.js"], { browser });
    const results = [
      {
        seriesId: "A",
        title: "Show",
        status: "pending",
        pending: [
          { id: "e1", season: 2, number: 3 },
          { id: "e2", season: 2, number: 4 },
        ],
      },
    ];
    await CRChecker.updateBadge(results, browser);
    assert.equal(calls.title, "New episodes: 2 in 1 series");
    const n = plain(CRChecker.notificationText(CRChecker.pendingItems(results)));
    assert.deepEqual(n, { title: "2 new episodes", message: "Show: S2 E3, S2 E4" });
  });
});
