// Traduções. Os textos ficam em _locales/<código>/messages.json, um arquivo por
// idioma, no formato exigido pelo Firefox (pt_BR, pt_PT, en_US, es_ES…).
//
// O browser.i18n do Firefox só usa o idioma do navegador e não deixa trocar. Para
// o usuário poder escolher, a página e o segundo plano chamam init(escolha), que
// carrega o arquivo do idioma escolhido (ou o do navegador, em "auto"), com o
// inglês como reserva para alguma chave que falte. Antes do init (e nos testes),
// t() usa o browser.i18n.
//
//  - t("chave", a, b): texto traduzido com os marcadores $1, $2… preenchidos;
//  - tn("chave", n, ...): plural, escolhendo "chave_one" ou "chave_other" (n vira $1);
//  - lang(): idioma em uso, como código BCP 47 (ex.: "pt-BR", "en-US");
//  - langName("ja-JP"): nome do idioma, no idioma em uso;
//  - applyToDocument(): traduz os elementos com data-i18n* da página.

/* global browser */
var CRI18n = (() => {
  const api = () => (typeof browser !== "undefined" && browser.i18n) || null;

  // Idiomas da interface, com o nome de cada um no próprio idioma.
  const LANGUAGES = {
    pt_BR: "Português",
    pt_PT: "Português (Portugal)",
    en_US: "English",
    es_ES: "Español (España)",
    es_419: "Español (Latinoamérica)",
    fr_FR: "Français",
    de_DE: "Deutsch",
    it_IT: "Italiano",
    ja_JP: "日本語",
    zh_CN: "简体中文",
    zh_TW: "繁體中文",
    ko_KR: "한국어",
    hi_IN: "हिन्दी",
    bn_IN: "বাংলা",
    mr_IN: "मराठी",
    te_IN: "తెలుగు",
    ta_IN: "தமிழ்",
    ur_PK: "اردو",
    ar_SA: "العربية",
    ru_RU: "Русский",
    tr_TR: "Türkçe",
    id_ID: "Bahasa Indonesia",
    vi_VN: "Tiếng Việt",
  };
  // Idiomas escritos da direita para a esquerda.
  const RTL = new Set(["ar_SA", "ur_PK"]);
  const FALLBACK = "en_US";

  let current = null; // pasta em uso (ex.: "pt_BR"), depois do init
  let messages = null;
  let reserve = null;

  // "pt-br" → "pt_BR"; "es-419" → "es_419"; o script ("zh-Hant-TW") é ignorado aqui.
  const toFolder = (code) => {
    const parts = String(code || "").replace(/_/g, "-").split("-").filter((p) => !/^[A-Za-z]{4}$/.test(p));
    const [l, r] = parts;
    return r ? `${l.toLowerCase()}_${/^\d+$/.test(r) ? r : r.toUpperCase()}` : (l || "").toLowerCase();
  };
  const toBcp47 = (folder) => folder.replace("_", "-");

  function browserLang() {
    const i = api();
    return (
      (i && i.getUILanguage && i.getUILanguage()) ||
      (typeof navigator !== "undefined" && navigator.language) ||
      "en-US"
    );
  }

  // Idioma do navegador (ou um código qualquer) → a pasta de tradução mais próxima.
  function resolve(code) {
    const f = toFolder(code);
    if (LANGUAGES[f]) return f;
    const lang = f.split("_")[0];
    if (lang === "pt") return "pt_BR"; // pt-PT já caiu acima; pt-AO, pt-MZ… → pt_BR
    if (lang === "es") return "es_419"; // es-ES já caiu acima; es-MX, es-AR… → América Latina
    if (lang === "zh") {
      // Tradicional em Taiwan, Hong Kong e Macau (e quando o script Hant vem no código).
      return /Hant|[-_](TW|HK|MO)\b/i.test(String(code)) ? "zh_TW" : "zh_CN";
    }
    if (lang === "yue") return "zh_TW"; // cantonês escrito em caracteres tradicionais
    const same = Object.keys(LANGUAGES).find((k) => k.split("_")[0] === lang);
    return same || FALLBACK;
  }

  async function fetchMessages(folder) {
    const url = browser.runtime.getURL(`_locales/${folder}/messages.json`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  }

  /** choice: "auto" (idioma do navegador) ou uma pasta de LANGUAGES. */
  async function init(choice = "auto") {
    const folder = choice && choice !== "auto" && LANGUAGES[choice] ? choice : resolve(browserLang());
    try {
      const [main, back] = await Promise.all([
        fetchMessages(folder),
        folder === FALLBACK ? null : fetchMessages(FALLBACK).catch(() => null),
      ]);
      messages = main;
      reserve = back;
      current = folder;
    } catch (err) {
      console.warn("[CRI18n]", err);
      messages = null; // segue com o browser.i18n
      reserve = null;
      current = null;
    }
    return current;
  }

  // Para testes: usa um conjunto de mensagens já carregado.
  function use(folder, main, back = null) {
    current = folder;
    messages = main;
    reserve = back;
  }

  // Igual ao browser.i18n.getMessage: marcadores nomeados ($NOME$) → conteúdo
  // ("$1") → substituições; "$$" vira "$".
  function format(entry, subs) {
    const fill = (text) => text.replace(/\$(\d)/g, (_, n) => (subs[n - 1] != null ? String(subs[n - 1]) : ""));
    const ph = entry.placeholders || {};
    const named = entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (m, name) => {
      const p = ph[name.toLowerCase()];
      return p ? fill(p.content) : m;
    });
    return fill(named).replace(/\$\$/g, "$");
  }

  function t(key, ...subs) {
    const strs = subs.map((s) => String(s));
    const entry = (messages && messages[key]) || (reserve && reserve[key]);
    if (entry) return format(entry, strs);
    const i = api();
    const msg = i ? i.getMessage(key, strs) : "";
    return msg || key;
  }

  function lang() {
    return current ? toBcp47(current) : browserLang();
  }

  function pluralRule(n) {
    if (n === 0) return "other"; // "0 episódios" (o CLDR do português trataria 0 como singular)
    try {
      return new Intl.PluralRules(lang()).select(n) === "one" ? "one" : "other";
    } catch (_) {
      return n === 1 ? "one" : "other";
    }
  }

  const tn = (key, n, ...subs) => t(`${key}_${pluralRule(n)}`, n, ...subs);

  // pt-BR aparece só como "Português" (e não "Português (Brasil)"); pt-PT continua
  // "Português (Portugal)".
  function langName(code) {
    const shown = code === "pt-BR" ? "pt" : code;
    try {
      const name = new Intl.DisplayNames([lang()], { type: "language" }).of(shown);
      if (name && name !== shown) return name.charAt(0).toLocaleUpperCase(lang()) + name.slice(1);
    } catch (_) {}
    return code;
  }

  // Opções do seletor de idioma: [valor, rótulo].
  const languageOptions = () => [["auto", t("uiLangAuto")], ...Object.entries(LANGUAGES)];

  const dir = () => (current && RTL.has(current) ? "rtl" : "ltr");

  function applyToDocument(doc = document) {
    if (doc.documentElement) {
      doc.documentElement.lang = lang();
      doc.documentElement.dir = dir();
    }
    for (const el of doc.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const [attr, prop] of [
      ["placeholder", "i18nPlaceholder"],
      ["aria-label", "i18nAriaLabel"],
      ["title", "i18nTitle"],
    ]) {
      for (const el of doc.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.dataset[prop]));
    }
  }

  return { t, tn, lang, dir, langName, applyToDocument, init, use, resolve, languageOptions, LANGUAGES, FALLBACK };
})();
