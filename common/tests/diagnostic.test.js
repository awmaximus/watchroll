"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeBrowser, episode, playhead, plain, apiFromDiagnostic, jwt } = require("./helpers");

const FULL = 24 * 60;
const settings = (over = {}) => ({ locale: "pt-BR", dubLang: "pt-BR", defaultMode: "sub", seriesModes: {}, ...over });

function analyzerWith(CRApi) {
  return load(["src/analyzer.js"], { browser: fakeBrowser(), CRApi }).CRAnalyzer;
}

describe("exportar diagnóstico", () => {
  const ACCOUNT = "11111111-2222-3333-4444-555555555555";
  const entry = { seriesId: "S", title: "Série S", slug: "serie-s", image: null, neverWatchedFlag: false };
  const fakeApi = () => ({
    getAccountId: async () => ACCOUNT,
    seasons: async () => [{ id: "T1", season_sequence_number: 1 }],
    episodes: async () => [episode("e1", 1), episode("e2", 2), episode("e3", 3)],
    // Resposta com campos sensíveis misturados, para conferir a limpeza.
    playheads: async (ids) =>
      new Map(
        ids
          .filter((i) => i === "e1")
          .map((i) => [i, { ...playhead(i, FULL, true), account_id: ACCOUNT, profile_id: "perfil-x" }])
      ),
  });

  test("grava temporadas, episódios e playheads usados na análise", async () => {
    const analyzer = analyzerWith(fakeApi());
    const d = await analyzer.diagnose(entry, settings(), { version: "9.9.9" });
    assert.equal(d.tipo, "crnovos-diagnostico");
    assert.equal(d.versaoExtensao, "9.9.9");
    assert.equal(d.configuracao.modo, "sub");
    assert.deepEqual(Object.keys(d.respostas.temporadas), ["S"]);
    assert.deepEqual(Object.keys(d.respostas.episodios), ["T1"]);
    assert.equal(d.respostas.episodios.T1.length, 3);
    assert.deepEqual(plain(d.respostas.playheads.map((p) => p.content_id)), ["e1"]);
    assert.deepEqual(plain(d.resultado.pending.map((p) => p.id)), ["e2", "e3"]);
  });

  test("não contém ID da conta, perfil, token nem cookie", async () => {
    const analyzer = analyzerWith(fakeApi());
    const text = JSON.stringify(await analyzer.diagnose(entry, settings()));
    assert.ok(!text.includes(ACCOUNT), "ID da conta vazou");
    assert.ok(!text.includes("perfil-x"), "ID do perfil vazou");
    assert.doesNotMatch(text, /account_id|profile_id|token|cookie|authorization/i);
  });

  test("limpeza remove chaves sensíveis em qualquer nível", () => {
    const analyzer = analyzerWith(fakeApi());
    const dirty = {
      ok: 1,
      access_token: jwt({ a: 1 }),
      nested: [{ Cookie: "etp_rt=x", keep: "sim", deep: { refresh_token: "r", etp_rt: "y", fine: true } }],
    };
    assert.deepEqual(plain(analyzer.sanitize(dirty)), { ok: 1, nested: [{ keep: "sim", deep: { fine: true } }] });
  });

  test("um diagnóstico exportado reproduz o mesmo resultado quando reaplicado", async () => {
    const original = analyzerWith(fakeApi());
    const d = plain(await original.diagnose(entry, settings()));
    const replay = analyzerWith(apiFromDiagnostic(d));
    const [r] = await replay.run({ settings: settings() });
    assert.equal(r.status, d.resultado.status);
    assert.deepEqual(plain(r.pending.map((p) => p.id)), plain(d.resultado.pending.map((p) => p.id)));
  });

  test("erro da API vira resultado de erro no diagnóstico, sem lançar", async () => {
    const api = { ...fakeApi(), seasons: async () => { throw new Error("HTTP 500 em seasons"); } };
    const d = await analyzerWith(api).diagnose(entry, settings());
    assert.equal(d.resultado.status, "error");
    assert.match(d.resultado.error, /HTTP 500/);
  });
});
