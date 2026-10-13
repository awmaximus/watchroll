// Página da extensão: lista o que falta assistir e guarda as preferências.
// Conteúdo vindo da API entra sempre por textContent/atributos (nada de innerHTML).

/* global browser, CRApi, CRAnalyzer */
(() => {
  const SETTINGS_KEY = "crnovos:settings";
  const LANGS = [
    ["pt-BR", "Português (Brasil)"],
    ["es-419", "Espanhol (América Latina)"],
    ["es-ES", "Espanhol (Espanha)"],
    ["en-US", "Inglês"],
    ["fr-FR", "Francês"],
    ["de-DE", "Alemão"],
    ["it-IT", "Italiano"],
    ["ru-RU", "Russo"],
    ["ar-SA", "Árabe"],
    ["hi-IN", "Hindi"],
  ];
  const langName = (code) => (LANGS.find(([c]) => c === code) || [code, code])[1];
  const MAX_EPS = 5;

  const DEFAULTS = {
    locale: "pt-BR",
    dubLang: "pt-BR",
    defaultMode: "sub",
    concurrency: CRAnalyzer.CONCURRENCY.default,
    seriesModes: {},
  };
  let settings = { ...DEFAULTS };
  let results = [];
  let busy = false;

  const $ = (id) => document.getElementById(id);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null) node.append(c);
    return node;
  }

  // ---------- preferências ----------
  async function loadSettings() {
    const saved = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
    settings = { ...DEFAULTS, ...saved, seriesModes: { ...(saved.seriesModes || {}) } };
  }
  const saveSettings = () => browser.storage.local.set({ [SETTINGS_KEY]: settings });

  const shortMode = (m) => (m === "dub" ? `dublado ${settings.dubLang}` : m === "sub" ? "legendado" : "qualquer áudio");

  function fillSelect(select, options, value) {
    select.replaceChildren(...options.map(([v, t]) => el("option", { value: v, text: t })));
    select.value = value;
  }

  function renderSettingsForm() {
    fillSelect($("set-dub"), LANGS, settings.dubLang);
    fillSelect(
      $("set-mode"),
      [
        ["sub", "Legendado"],
        ["dub", "Dublado"],
        ["auto", "Qualquer áudio (avisa no primeiro que sair)"],
      ],
      settings.defaultMode
    );
    fillSelect($("set-locale"), LANGS, settings.locale);
    const conc = $("set-concurrency");
    conc.min = CRAnalyzer.CONCURRENCY.min;
    conc.max = CRAnalyzer.CONCURRENCY.max;
    conc.value = CRAnalyzer.concurrencyFrom(settings);
  }

  // ---------- links ----------
  function prefix() {
    const l = settings.locale.toLowerCase();
    return l === "en-us" ? "" : "/" + l;
  }
  const watchUrl = (ep) => `https://www.crunchyroll.com${prefix()}/watch/${ep.id}/${ep.slug}`;
  const seriesUrl = (s) => `https://www.crunchyroll.com${prefix()}/series/${s.seriesId}/${s.slug || ""}`;

  function relTime(ts) {
    if (!ts) return "";
    const diff = Date.now() - ts;
    const day = 86400000;
    if (diff < 0) return "";
    if (diff < 3600000) return "agora há pouco";
    if (diff < day) return `há ${Math.floor(diff / 3600000)} h`;
    if (diff < 2 * day) return "ontem";
    if (diff < 30 * day) return `há ${Math.floor(diff / day)} dias`;
    return new Date(ts).toLocaleDateString("pt-BR");
  }

  // ---------- componentes ----------
  function modeSelect(s) {
    const current = settings.seriesModes[s.seriesId] || "";
    const select = el(
      "select",
      { class: "mode", "aria-label": `Áudio de ${s.title}`, title: "Como você assiste esta série" },
      el("option", { value: "", text: `Padrão (${shortMode(settings.defaultMode)})` }),
      el("option", { value: "sub", text: "Legendado" }),
      el("option", { value: "dub", text: `Dublado ${settings.dubLang}` }),
      el("option", { value: "auto", text: "Qualquer áudio" })
    );
    select.value = current;
    select.addEventListener("change", () => changeMode(s, select.value));
    return select;
  }

  // Menu de ações por série. Cada ação: [valor, rótulo, função].
  function seriesActions(s) {
    return [["diag", "Exportar diagnóstico", () => exportDiagnostic(s)]];
  }

  function actionsSelect(s) {
    const actions = seriesActions(s);
    const select = el(
      "select",
      { class: "actions", "aria-label": `Ações para ${s.title}`, title: "Ações" },
      el("option", { value: "", text: "⋯" }),
      actions.map(([v, t]) => el("option", { value: v, text: t }))
    );
    select.addEventListener("change", () => {
      const chosen = actions.find(([v]) => v === select.value);
      select.value = "";
      if (chosen) chosen[2]();
    });
    return select;
  }

  function episodeRow(ep) {
    return el(
      "li",
      {},
      el(
        "a",
        { href: watchUrl(ep), target: "_blank", rel: "noopener", title: ep.title },
        el("span", { class: "epnum", text: `T${ep.season ?? "?"} E${ep.number || "?"}` }),
        el("span", { class: "eptitle", text: ep.title || ep.seasonTitle }),
        ep.inProgress
          ? el(
              "span",
              { class: "prog", title: `${Math.round(ep.progress * 100)}% assistido` },
              el("span", { style: `width:${Math.round(ep.progress * 100)}%` })
            )
          : el("span", { class: "when", text: relTime(ep.availableAt) })
      )
    );
  }

  function card(s) {
    const shown = s.pending.slice(0, MAX_EPS);
    const extra = s.pending.length - shown.length;
    const first = s.pending[0];
    return el(
      "article",
      { class: "card", "data-series": s.seriesId },
      el(
        "a",
        { class: "thumb", href: watchUrl(first), target: "_blank", rel: "noopener", title: "Assistir o próximo" },
        s.image ? el("img", { src: s.image, alt: "", loading: "lazy" }) : null,
        el("span", { class: "badge", text: `${s.pending.length} novo${s.pending.length > 1 ? "s" : ""}` }),
        el("span", { class: "play", "aria-hidden": "true", text: "▶" })
      ),
      el(
        "div",
        { class: "info" },
        el("a", { class: "series", href: seriesUrl(s), target: "_blank", rel: "noopener", text: s.title, title: s.title }),
        el(
          "ul",
          { class: "eps" },
          shown.map(episodeRow),
          extra > 0 ? el("li", { class: "more", text: `+ ${extra} episódio${extra > 1 ? "s" : ""}` }) : null
        ),
        el(
          "div",
          { class: "card-foot" },
          modeSelect(s),
          actionsSelect(s),
          s.waitingDub
            ? el("span", { class: "hint", text: `+${s.waitingDub} aguardando dublagem` })
            : null
        )
      )
    );
  }

  function row(s, note) {
    return el(
      "li",
      { class: "row", "data-series": s.seriesId },
      s.image ? el("img", { src: s.image, alt: "", loading: "lazy" }) : el("span", { class: "noimg" }),
      el(
        "div",
        { class: "row-text" },
        el("a", { href: seriesUrl(s), target: "_blank", rel: "noopener", text: s.title }),
        note ? el("small", { text: note }) : null
      ),
      el("div", { class: "row-actions" }, modeSelect(s), actionsSelect(s))
    );
  }

  function section(title, count, content, { open = true, id } = {}) {
    return el(
      "details",
      { class: "section", open: open || null, id },
      el("summary", {}, el("h2", { text: title }), el("span", { class: "count", text: String(count) })),
      content
    );
  }

  // ---------- render ----------
  const maxAvail = (r) => Math.max(0, ...r.pending.map((p) => p.availableAt || 0));
  const byTitle = (a, b) => (a.title || "").localeCompare(b.title || "", "pt-BR");

  function render() {
    const pending = results.filter((r) => r.status === "pending").sort((a, b) => maxAvail(b) - maxAvail(a));
    const waiting = results.filter((r) => r.status === "uptodate" && r.waitingDub).sort(byTitle);
    const upToDate = results.filter((r) => r.status === "uptodate" && !r.waitingDub).sort(byTitle);
    const never = results.filter((r) => r.status === "never").sort(byTitle);
    const errors = results.filter((r) => r.status === "error").sort(byTitle);

    const totalEps = pending.reduce((n, r) => n + r.pending.length, 0);
    $("status").textContent = results.length
      ? pending.length
        ? `${totalEps} episódio${totalEps > 1 ? "s" : ""} em ${pending.length} série${pending.length > 1 ? "s" : ""}`
        : "Tudo em dia"
      : "";

    const parts = [];
    parts.push(
      section(
        "Para assistir",
        pending.length,
        pending.length
          ? el("div", { class: "grid" }, pending.map(card))
          : el("p", { class: "empty", text: "Nenhum episódio novo nas séries que você já começou." })
      )
    );
    if (waiting.length) {
      parts.push(
        section(
          "Aguardando dublagem",
          waiting.length,
          el(
            "ul",
            { class: "rows" },
            waiting.map((s) => row(s, s.waitingDub === 1 ? "1 já saiu legendado" : `${s.waitingDub} já saíram legendados`))
          )
        )
      );
    }
    if (errors.length) {
      parts.push(
        section(
          "Não consegui verificar",
          errors.length,
          el("ul", { class: "rows" }, errors.map((s) => row(s, s.error)))
        )
      );
    }
    parts.push(
      section(
        "Em dia",
        upToDate.length,
        el(
          "ul",
          { class: "rows" },
          upToDate.map((s) =>
            row(s, s.dubMissing ? `Sem dublagem ${settings.dubLang} nesta temporada` : null)
          )
        ),
        { open: false }
      )
    );
    parts.push(
      section(
        "Ainda não começadas",
        never.length,
        el("ul", { class: "rows" }, never.map((s) => row(s, null))),
        { open: false }
      )
    );
    $("content").replaceChildren(...parts);
  }

  // ---------- ações ----------
  function setBusy(on) {
    busy = on;
    $("btn-refresh").disabled = on;
    $("progress").hidden = !on;
    document.body.classList.toggle("busy", on);
  }
  function setProgress(done, total) {
    $("status").textContent = total ? `Verificando ${done} de ${total} séries…` : "Lendo sua Fila…";
    $("progress").firstElementChild.style.width = total ? `${(done / total) * 100}%` : "5%";
  }
  function notice(msg) {
    $("notice").hidden = !msg;
    $("notice").textContent = msg || "";
  }

  async function refresh(force = false) {
    if (busy) return;
    setBusy(true);
    notice("");
    try {
      setProgress(0, 0);
      results = await CRAnalyzer.run({ settings, force, onProgress: setProgress });
      render();
    } catch (err) {
      console.error("[Novos Episódios]", err);
      $("status").textContent = "";
      $("content").replaceChildren(
        el(
          "div",
          { class: "error-box" },
          el("p", { text: "Não foi possível consultar a Crunchyroll: " + (err.message || err) }),
          el("p", { text: "Confira se você está logado em crunchyroll.com e clique em Atualizar." })
        )
      );
    } finally {
      await CRApi.release();
      setBusy(false);
    }
  }

  // Salva um JSON com tudo o que a análise da série usou (sem token/cookie/IDs de
  // conta), para reproduzir problemas sem precisar copiar requisições do F12.
  async function exportDiagnostic(s) {
    const nodes = document.querySelectorAll(`[data-series="${CSS.escape(s.seriesId)}"]`);
    nodes.forEach((n) => n.classList.add("loading"));
    try {
      const diag = await CRAnalyzer.diagnose(s, settings, {
        version: browser.runtime.getManifest().version,
      });
      const blob = new Blob([JSON.stringify(diag, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const day = new Date().toISOString().slice(0, 10);
      const a = el("a", { href: url, download: `diagnostico-${s.slug || s.seriesId}-${day}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      notice(`Diagnóstico de “${s.title}” salvo. Ele não contém token, cookie nem dados da conta.`);
    } catch (err) {
      notice("Não foi possível gerar o diagnóstico: " + (err.message || err));
    } finally {
      nodes.forEach((n) => n.classList.remove("loading"));
      await CRApi.release();
    }
  }

  async function changeMode(s, value) {
    if (busy) {
      render(); // verificação completa em andamento: desfaz a mudança na tela
      return;
    }
    if (value) settings.seriesModes[s.seriesId] = value;
    else delete settings.seriesModes[s.seriesId];
    await saveSettings();

    for (const n of document.querySelectorAll(`[data-series="${CSS.escape(s.seriesId)}"]`)) {
      n.classList.add("loading");
    }
    try {
      const updated = await CRAnalyzer.runOne(s, settings);
      results = results.map((r) => (r.seriesId === s.seriesId ? updated : r));
    } finally {
      await CRApi.release();
      render();
    }
  }

  // ---------- início ----------
  async function init() {
    await loadSettings();
    renderSettingsForm();
    CRApi.setNoticeHandler(notice);

    $("btn-refresh").addEventListener("click", () => refresh(true));
    $("btn-settings").addEventListener("click", () => {
      const panel = $("settings");
      panel.hidden = !panel.hidden;
      $("btn-settings").setAttribute("aria-expanded", String(!panel.hidden));
    });
    const onSetting = (key) => async (e) => {
      settings[key] = e.target.value;
      await saveSettings();
      refresh(false); // o cache só é reaproveitado onde o resultado não depende da mudança
    };
    $("set-dub").addEventListener("change", onSetting("dubLang"));
    $("set-mode").addEventListener("change", onSetting("defaultMode"));
    $("set-locale").addEventListener("change", onSetting("locale"));
    // Só vale para a próxima verificação; não precisa refazer a atual.
    $("set-concurrency").addEventListener("change", async (e) => {
      settings.concurrency = CRAnalyzer.concurrencyFrom({ concurrency: e.target.value });
      e.target.value = settings.concurrency;
      await saveSettings();
    });

    refresh(false);
  }

  init();
})();
