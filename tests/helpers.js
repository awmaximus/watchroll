// Utilitários dos testes: carregam os scripts da extensão num contexto isolado (vm)
// com uma API "browser" falsa, já que eles são scripts de navegador, não módulos.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Raiz do repositório e a pasta do código comum aos navegadores (common/). Os
// caminhos dos testes ("src/api.js", "_locales/…") são relativos a common/.
const REPO = path.join(__dirname, "..");
const ROOT = path.join(REPO, "common");
const FIREFOX = path.join(REPO, "firefox");

function memoryArea() {
  const data = {};
  return {
    data,
    async get(key) {
      if (typeof key === "string") return key in data ? { [key]: structuredClone(data[key]) } : {};
      return structuredClone(data);
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
    async remove(key) {
      delete data[key];
    },
  };
}

function fakeBrowser(overrides = {}) {
  const listeners = [];
  return {
    storage: { local: memoryArea(), session: memoryArea() },
    tabs: {
      query: async () => [],
      create: async () => ({ id: 99, status: "loading" }),
      remove: async () => {},
      sendMessage: async () => undefined,
      onUpdated: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
        fire: (...args) => [...listeners].forEach((fn) => fn(...args)),
      },
      ...(overrides.tabs || {}),
    },
    scripting: { executeScript: async () => [], ...(overrides.scripting || {}) },
  };
}

// ---------- traduções ----------
const readMessages = (folder) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, "_locales", folder, "messages.json"), "utf8"));

/** Imita browser.i18n.getMessage: marcadores nomeados ($NOME$) -> $1, $2… -> substituições. */
function formatMessage(entry, subs = []) {
  if (!entry) return "";
  const list = Array.isArray(subs) ? subs : [subs];
  const fill = (text) => text.replace(/\$(\d)/g, (_, n) => (list[n - 1] != null ? String(list[n - 1]) : ""));
  const ph = entry.placeholders || {};
  return entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (m, name) => {
    const p = ph[name.toLowerCase()];
    return p ? fill(p.content) : m;
  });
}

/** browser.i18n falso numa língua (padrão: pt_BR, a língua padrão da extensão). */
function fakeI18n(folder = "pt_BR", uiLanguage = folder.replace("_", "-")) {
  const messages = readMessages(folder);
  return {
    messages,
    getMessage: (key, subs) => formatMessage(messages[key], subs),
    getUILanguage: () => uiLanguage,
  };
}

/** Carrega scripts da extensão e devolve o contexto (globais `var` ficam nele).
 *  src/i18n.js é carregado antes de tudo, como no manifesto e na página. */
function load(files, globals = {}) {
  const browser = globals.browser || {};
  if (!browser.i18n) browser.i18n = fakeI18n();
  const ctx = vm.createContext({
    console,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    structuredClone,
    atob,
    btoa,
    crypto: { randomUUID: () => "device-uuid" },
    ...globals,
    browser,
  });
  if (!files.includes("src/i18n.js")) files = ["src/i18n.js", ...files];
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
  }
  return ctx;
}

/** JWT falso (só o payload importa para a extensão). */
function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

// ---------- construção de dados no formato da API ----------
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();

function episode(id, seq, opts = {}) {
  const now = Date.now();
  return {
    id,
    title: opts.title || `Episódio ${seq}`,
    slug_title: `episodio-${seq}`,
    sequence_number: seq,
    episode: String(seq),
    season_number: opts.season ?? 1,
    duration_ms: 24 * 60 * 1000,
    availability_status: opts.status || "available",
    availability_starts: iso(opts.availableAt ?? now - (30 - seq) * DAY),
    audio_locale: opts.audio || "ja-JP",
    is_clip: !!opts.clip,
    versions: opts.versions || [{ guid: id, audio_locale: opts.audio || "ja-JP", original: true }],
    images: { thumbnail: [[{ source: `https://img/${id}.jpg`, width: 320 }]] },
  };
}

function playhead(id, seconds, fully = false, modifiedAt = Date.now()) {
  return { content_id: id, playhead: seconds, fully_watched: fully, last_modified: iso(modifiedAt) };
}

/** Copia valores criados dentro do vm para objetos "normais" (outro realm). */
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * API falsa que responde com o que foi gravado num diagnóstico exportado pela página
 * ("Ações → Exportar diagnóstico"). Serve para transformar um bug relatado em teste.
 */
function apiFromDiagnostic(diag) {
  const r = diag.respostas;
  const s = diag.serie;
  return {
    getAccountId: async () => "conta-diagnostico",
    watchlist: async () => [
      { never_watched: !!s.neverWatchedFlag, panel: { type: "series", id: s.seriesId, title: s.title, slug_title: s.slug } },
    ],
    seasons: async (id) => r.temporadas[id] || [],
    episodes: async (id) => r.episodios[id] || [],
    playheads: async (ids) => new Map(r.playheads.filter((p) => ids.includes(p.content_id)).map((p) => [p.content_id, p])),
  };
}

module.exports = { apiFromDiagnostic, plain, load, fakeBrowser, fakeI18n, formatMessage, readMessages, jwt, episode, playhead, DAY, iso, ROOT, REPO, FIREFOX };
