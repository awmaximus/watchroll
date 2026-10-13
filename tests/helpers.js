// Utilitários dos testes: carregam os scripts da extensão num contexto isolado (vm)
// com uma API "browser" falsa, já que eles são scripts de navegador, não módulos.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

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

/** Carrega scripts da extensão e devolve o contexto (globais `var` ficam nele). */
function load(files, globals = {}) {
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
  });
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

module.exports = { plain, load, fakeBrowser, jwt, episode, playhead, DAY, iso };
