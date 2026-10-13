// Traduções. Os textos ficam em _locales/<língua>/messages.json (padrão: pt_BR).
//  - t("chave", a, b): texto traduzido com os marcadores $1, $2… preenchidos;
//  - tn("chave", n, ...): plural, escolhendo "chave_one" ou "chave_other" (n vira $1);
//  - lang(): língua da interface do Firefox (ex.: "pt-BR", "en-US");
//  - langName("ja-JP"): nome do idioma na língua da interface;
//  - applyToDocument(): traduz os elementos com data-i18n* da página.

/* global browser */
var CRI18n = (() => {
  const api = () => (typeof browser !== "undefined" && browser.i18n) || null;

  function t(key, ...subs) {
    const i = api();
    const msg = i ? i.getMessage(key, subs.map((s) => String(s))) : "";
    return msg || key;
  }

  function lang() {
    const i = api();
    return (i && i.getUILanguage && i.getUILanguage()) || "pt-BR";
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

  function langName(code) {
    try {
      const name = new Intl.DisplayNames([lang()], { type: "language" }).of(code);
      if (name && name !== code) return name.charAt(0).toLocaleUpperCase(lang()) + name.slice(1);
    } catch (_) {}
    return code;
  }

  function applyToDocument(doc = document) {
    if (doc.documentElement) doc.documentElement.lang = lang();
    for (const el of doc.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const [attr, prop] of [
      ["placeholder", "i18nPlaceholder"],
      ["aria-label", "i18nAriaLabel"],
      ["title", "i18nTitle"],
    ]) {
      for (const el of doc.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.dataset[prop]));
    }
  }

  return { t, tn, lang, langName, applyToDocument };
})();
