// Segundo plano no Chrome e derivados (Manifest V3 usa um service worker em vez da
// página de segundo plano do Firefox). Carrega os mesmos scripts comuns, na mesma
// ordem do firefox/manifest.json, com a camada de compatibilidade (compat.js) antes.
/* global importScripts */
importScripts(
  "src/compat.js",
  "src/i18n.js",
  "src/api.js",
  "src/analyzer.js",
  "src/checker.js",
  "src/background.js"
);
