"use strict";
// Analisador + API reais juntos; só o fetch é simulado.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeBrowser, jwt, episode } = require("./helpers");

const ACC = "11111111-2222-3333-4444-555555555555";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status });

function crunchyroll(seriesCount) {
  const requests = [];
  const fetch = async (url) => {
    const u = new URL(url);
    requests.push(u.pathname);
    let m;
    if (u.pathname.endsWith("/watchlist")) {
      return json({
        data: Array.from({ length: seriesCount }, (_, i) => ({ panel: { type: "series", id: `S${i}`, title: `Série ${i}` } })),
        total: seriesCount,
      });
    }
    if (u.pathname.endsWith("/watch-history")) return json({ data: [], meta: { next_page: "" } });
    if ((m = u.pathname.match(/\/cms\/series\/(\w+)\/seasons$/))) return json({ data: [{ id: `T-${m[1]}`, season_sequence_number: 1 }] });
    if ((m = u.pathname.match(/\/cms\/seasons\/T-(\w+)\/episodes$/))) {
      return json({ data: [1, 2, 3].map((n) => episode(`${m[1]}-e${n}`, n)) });
    }
    if (u.pathname.endsWith("/playheads")) {
      const ids = u.searchParams.get("content_ids").split(",");
      return json({ data: ids.filter((id) => id.endsWith("-e1")).map((id) => ({ content_id: id, playhead: 1440, fully_watched: true })) });
    }
    return json({}, 404);
  };
  const browser = fakeBrowser();
  browser.storage.session.data.crToken = { token: jwt({ account_id: ACC }), exp: Date.now() + 600000 };
  const ctx = load(["src/api.js", "src/analyzer.js"], { browser, fetch, Response });
  return { analyzer: ctx.CRAnalyzer, requests };
}

test("6 séries em paralelo: playheads saem em uma consulta só, resultado correto", async () => {
  const { analyzer, requests } = crunchyroll(6);
  const results = await analyzer.run({
    settings: { locale: "pt-BR", dubLang: "pt-BR", defaultMode: "sub", seriesModes: {}, concurrency: 6 },
  });
  assert.equal(results.length, 6);
  for (const r of results) {
    assert.equal(r.status, "pending");
    assert.deepEqual(JSON.parse(JSON.stringify(r.pending.map((p) => p.number))), ["2", "3"]);
  }
  const playheadCalls = requests.filter((p) => p.endsWith("/playheads")).length;
  assert.equal(playheadCalls, 1, `foram ${playheadCalls} consultas de playheads`);
});
