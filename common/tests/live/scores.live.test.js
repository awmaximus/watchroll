// Testes de acesso real ao AniList e ao MyAnimeList (precisam de internet).
//
// Ficam fora de `npm test` (que não usa a rede e roda no CI). Rode à mão:
//   npm --prefix firefox run test:live
//
// Servem para saber se, da sua rede, as APIs respondem e se o Client ID do
// MyAnimeList (common/src/mal-client.js) é aceito. Usam o mesmo código da extensão
// (common/src/scores.js); só o armazenamento é falso.
//
// Obs.: no Node não existe CORS nem permissão de extensão. Se aqui passar e na
// extensão não, o problema é a permissão para api.myanimelist.net no navegador.
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeBrowser } = require("../helpers");

const APOTHECARY = { id: "G3KHEVDJ7", title: "Diários de uma Apotecária", slug: "the-apothecary-diaries" };
const FRIEREN = { id: "GG5H5XQX4", title: "Frieren", slug: "frieren-beyond-journeys-end" };
const APOTHECARY_MAL = 54492; // ID do MyAnimeList (conferido em nov/2026)
const TIMEOUT = 30000;

function setup() {
  const b = fakeBrowser();
  const ctx = load(["src/mal-client.js", "src/scores.js"], { browser: b, AbortController, fetch });
  return { S: ctx.CRScores, clientId: ctx.MAL_CLIENT_ID, b };
}

describe("AniList (graphql.anilist.co)", () => {
  test("acha a série pelo nome da Crunchyroll e traz nota e ID do MyAnimeList", { timeout: TIMEOUT }, async () => {
    const { S } = setup();
    const found = await S.anilistFor([APOTHECARY, FRIEREN], fetch);
    const ap = found.get(APOTHECARY.id);
    assert.ok(ap, "AniList não achou The Apothecary Diaries");
    assert.equal(ap.id, 161645);
    assert.equal(ap.idMal, APOTHECARY_MAL);
    assert.equal(typeof ap.score, "number");
    assert.ok(ap.score > 0 && ap.score <= 100, `nota fora de 0–100: ${ap.score}`);
    const fr = found.get(FRIEREN.id);
    assert.ok(fr && fr.idMal, "AniList não achou Frieren (título com apóstrofo)");
  });
});

describe("MyAnimeList — API oficial (api.myanimelist.net)", () => {
  test("Client ID configurado em common/src/mal-client.js", () => {
    const { clientId } = setup();
    assert.ok(clientId && clientId.trim(), "MAL_CLIENT_ID está vazio");
    assert.match(clientId.trim(), /^[0-9a-f]{32}$/, "o Client ID do MyAnimeList tem 32 caracteres hexadecimais");
  });

  test("o Client ID é aceito e a nota vem", { timeout: TIMEOUT }, async (t) => {
    const { S, clientId } = setup();
    if (!clientId) return t.skip("sem Client ID");
    const r = await S.malScore(APOTHECARY_MAL, fetch);
    assert.equal(typeof r.score, "number", "a API não devolveu a nota (campo mean)");
    assert.ok(r.score > 0 && r.score <= 10, `nota fora de 0–10: ${r.score}`);
    assert.ok(r.users > 0, "sem o número de votos (num_scoring_users)");
  });

  test("Client ID errado é recusado (confere que o cabeçalho é mesmo usado)", { timeout: TIMEOUT }, async (t) => {
    const { S, clientId } = setup();
    if (!clientId) return t.skip("sem Client ID");
    S.setClientId("00000000000000000000000000000000");
    await assert.rejects(S.malScore(APOTHECARY_MAL, fetch), /MyAnimeList HTTP (400|401|403)/);
  });
});

describe("MyAnimeList — Jikan (api.jikan.moe, reserva sem Client ID)", () => {
  test("responde com a nota", { timeout: TIMEOUT }, async () => {
    const { S } = setup();
    S.setClientId("");
    const r = await S.malScore(APOTHECARY_MAL, fetch);
    assert.equal(typeof r.score, "number");
    assert.ok(r.score > 0 && r.score <= 10);
  });
});

describe("de ponta a ponta (como a extensão faz)", () => {
  test("AniList e depois MyAnimeList, com as notas guardadas", { timeout: 60000 }, async () => {
    const { S, b } = setup();
    const all = await S.update([APOTHECARY], { fetchFn: fetch, b });
    const sc = S.scoresOf(all, APOTHECARY.id);
    assert.equal(typeof sc.al, "number", "sem nota do AniList");
    assert.equal(sc.malId, APOTHECARY_MAL);
    assert.equal(typeof sc.mal, "number", `sem nota do MyAnimeList (guardado: ${JSON.stringify(all[APOTHECARY.id].mal)})`);
  });
});
