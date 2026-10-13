// Página da extensão: lista o que falta assistir e guarda as preferências.
// Conteúdo vindo da API entra sempre por textContent/atributos (nada de innerHTML).

/* global browser, CRApi, CRAnalyzer, CRChecker */
(() => {
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

  let settings = { ...CRChecker.DEFAULT_SETTINGS };
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
    settings = await CRChecker.loadSettings();
  }
  const saveSettings = () => CRChecker.saveSettings(settings);

  const shortMode = (m) => (m === "dub" ? `dublado ${settings.dubLang}` : m === "sub" ? "legendado" : "qualquer áudio");

  function fillSelect(select, options, value) {
    select.replaceChildren(...options.map(([v, t]) => el("option", { value: v, text: t })));
    select.value = value;
  }

  function renderSettingsForm() {
    fillSelect($("set-dub"), LANGS, settings.dubLang);
    fillSelect($("set-sub"), LANGS, settings.subLang);
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
    fillSelect(
      $("set-auto"),
      CRChecker.AUTO_CHECK_OPTIONS.map((m) => [
        String(m),
        m === 0 ? "Desligado" : m < 60 ? `A cada ${m} minutos` : m === 60 ? "A cada hora" : `A cada ${m / 60} horas`,
      ]),
      String(CRChecker.autoCheckMinutes(settings))
    );
    $("set-notify").checked = settings.notify !== false;
    $("set-extras").checked = settings.showExtras !== false;
    $("set-skipped").checked = !!settings.showSkipped;
    const ms = $("set-minstarted");
    ms.min = CRAnalyzer.MIN_STARTED.min;
    ms.max = CRAnalyzer.MIN_STARTED.max;
    ms.value = CRAnalyzer.minStartedFrom(settings);
  }

  // ---------- links ----------
  function prefix() {
    const l = settings.locale.toLowerCase();
    return l === "en-us" ? "" : "/" + l;
  }
  const watchUrl = (ep) => `https://www.crunchyroll.com${prefix()}/watch/${ep.id}/${ep.slug}`;
  // Filme: o título leva ao player (o primeiro filme pendente, se houver).
  const seriesUrl = (s) =>
    s.kind === "movie" && s.pending && s.pending[0]
      ? watchUrl(s.pending[0])
      : `https://www.crunchyroll.com${prefix()}/series/${s.seriesId}/${s.slug || ""}`;
  const epLabel = (ep) => (ep.kind === "movie" ? "Filme" : `T${ep.season ?? "?"} E${ep.number || "?"}`);

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

  // Data futura em linguagem natural: "hoje às 14:30", "amanhã às 14:30",
  // "em 3 dias (qui, 16/10)", ou só a data se for mais longe.
  function relFuture(ts, now = Date.now()) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOfDay(d) - startOfDay(new Date(now))) / 86400000);
    if (days <= 0) return `hoje às ${time}`;
    if (days === 1) return `amanhã às ${time}`;
    const date = d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
    if (days < 7) return `em ${days} dias (${date.replace(".", "")})`;
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  const nextText = (s) =>
    s.next ? `Próximo: T${s.next.season ?? "?"} E${s.next.number || "?"} ${relFuture(s.next.at)}` : null;

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
        el("span", { class: "epnum", text: epLabel(ep) }),
        ep.extra ? el("span", { class: "tag", text: ep.extra === "recap" ? "recap" : "especial" }) : null,
        ep.skipped ? el("span", { class: "tag", text: "pulado" }) : null,
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

  // Rótulo do card: episódios normais; se só houver extras, diz isso.
  function badgeLabel(s) {
    const main = s.pending.filter((p) => !p.extra && !p.skipped).length;
    if (s.kind === "movie") return s.pending.some((p) => p.inProgress) ? "continuar" : "filme";
    if (main) return `${main} novo${main > 1 ? "s" : ""}`;
    const skipped = s.pending.filter((p) => p.skipped).length;
    if (skipped) return skipped === 1 ? "1 pulado" : `${skipped} pulados`;
    const extras = s.pending.length;
    return extras === 1 ? "1 especial" : `${extras} especiais`;
  }

  function card(s) {
    const shown = s.pending.slice(0, MAX_EPS);
    const extra = s.pending.length - shown.length;
    // O link principal vai para o próximo episódio normal (se houver).
    const first = s.pending.find((p) => !p.extra && !p.skipped) || s.pending[0];
    return el(
      "article",
      { class: "card", "data-series": s.seriesId },
      el(
        "a",
        { class: "thumb", href: watchUrl(first), target: "_blank", rel: "noopener", title: "Assistir o próximo" },
        s.image ? el("img", { src: s.image, alt: "", loading: "lazy" }) : null,
        el("span", { class: "badge", text: badgeLabel(s) }),
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
            : null,
          s.waitingSub
            ? el("span", { class: "hint", text: `+${s.waitingSub} aguardando legenda` })
            : null,
          s.next ? el("span", { class: "hint next", text: nextText(s) }) : null
        )
      )
    );
  }

  function row(s, note, extraButton = null) {
    note = [note, nextText(s)].filter(Boolean).join(" · ");
    return el(
      "li",
      { class: "row", "data-series": s.seriesId },
      s.image ? el("img", { src: s.image, alt: "", loading: "lazy" }) : el("span", { class: "noimg" }),
      el(
        "div",
        { class: "row-text" },
        el("a", { href: seriesUrl(s), target: "_blank", rel: "noopener", text: s.title }),
        note ? el("small", { text: note, title: note }) : null
      ),
      el("div", { class: "row-actions" }, extraButton, modeSelect(s), actionsSelect(s))
    );
  }

  const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

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
    // Sem dublagem: a temporada atual não tem nenhum episódio no idioma escolhido
    // (a dublagem pode nunca sair). Aguardando: a dublagem existe e está atrasada.
    const noDub = results.filter((r) => r.status === "uptodate" && r.noDub && r.waitingDub).sort(byTitle);
    const waiting = results.filter((r) => r.status === "uptodate" && !r.noDub && r.waitingDub).sort(byTitle);
    const waitingSub = results.filter((r) => r.status === "uptodate" && !r.waitingDub && r.waitingSub).sort(byTitle);
    const upToDate = results.filter((r) => r.status === "uptodate" && !r.waitingDub && !r.waitingSub).sort(byTitle);
    const never = results.filter((r) => r.status === "never").sort(byTitle);
    const errors = results.filter((r) => r.status === "error").sort(byTitle);

    // Mesma contagem do ícone: sem especiais/recaps.
    const { episodes: totalEps, series: totalSeries } = CRChecker.summarize(results);
    $("status").textContent = results.length
      ? totalEps
        ? `${totalEps} episódio${totalEps > 1 ? "s" : ""} em ${totalSeries} série${totalSeries > 1 ? "s" : ""}`
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
    if (waitingSub.length) {
      parts.push(
        section(
          `Aguardando legenda em ${langName(settings.subLang)}`,
          waitingSub.length,
          el(
            "ul",
            { class: "rows" },
            waitingSub.map((s) => row(s, `${plural(s.waitingSub, "episódio já saiu", "episódios já saíram")} sem essa legenda`))
          )
        )
      );
    }
    if (noDub.length) {
      parts.push(
        section(
          `Sem dublagem em ${langName(settings.dubLang)}`,
          noDub.length,
          el(
            "ul",
            { class: "rows" },
            noDub.map((s) =>
              row(
                s,
                `Temporada atual sem dublagem ${settings.dubLang} · ${plural(s.waitingDub, "episódio legendado", "episódios legendados")} para ver`,
                el("button", {
                  class: "btn ghost small",
                  type: "button",
                  text: "Ver legendado",
                  title: "Muda esta série para o modo legendado",
                  onclick: () => changeMode(s, "sub"),
                })
              )
            )
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
            row(s, s.noDub ? `Sem dublagem ${settings.dubLang} na temporada atual` : null)
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
      // O que está na tela conta como visto: não vira notificação depois.
      await CRChecker.record(results, { scope: await CRAnalyzer.cacheScope() });
      showProfile();
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

  // Nome do perfil no topo, só se a conta tiver mais de um perfil.
  async function showProfile() {
    try {
      const [list, id] = await Promise.all([CRApi.profiles(), CRApi.getProfileId()]);
      const current = list.find((p) => p.profile_id === id) || list.find((p) => p.is_selected);
      $("profile").textContent = list.length > 1 && current ? ` · perfil ${current.profile_name}` : "";
    } catch (_) {
      $("profile").textContent = ""; // informação extra; sem ela a página funciona igual
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
      await CRChecker.record(results, { scope: await CRAnalyzer.cacheScope() });
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
    $("set-sub").addEventListener("change", onSetting("subLang"));
    $("set-mode").addEventListener("change", onSetting("defaultMode"));
    $("set-locale").addEventListener("change", onSetting("locale"));
    $("set-auto").addEventListener("change", async (e) => {
      settings.autoCheckMinutes = Number(e.target.value);
      await saveSettings(); // o segundo plano reagenda ao ver a mudança
    });
    $("set-notify").addEventListener("change", async (e) => {
      settings.notify = e.target.checked;
      await saveSettings();
    });
    $("set-extras").addEventListener("change", async (e) => {
      settings.showExtras = e.target.checked;
      await saveSettings();
      refresh(false);
    });
    $("set-skipped").addEventListener("change", async (e) => {
      settings.showSkipped = e.target.checked;
      await saveSettings();
      refresh(false);
    });
    $("set-minstarted").addEventListener("change", async (e) => {
      settings.minStartedSeconds = CRAnalyzer.minStartedFrom({ minStartedSeconds: e.target.value });
      e.target.value = settings.minStartedSeconds;
      await saveSettings();
      refresh(false); // muda o resultado: o cache dessa regra não serve
    });
    // Só vale para a próxima verificação; não precisa refazer a atual.
    $("set-concurrency").addEventListener("change", async (e) => {
      settings.concurrency = CRAnalyzer.concurrencyFrom({ concurrency: e.target.value });
      e.target.value = settings.concurrency;
      await saveSettings();
    });

    // Mostra na hora o último resultado conhecido enquanto atualiza.
    const last = await CRChecker.lastResults();
    if (last && Array.isArray(last.results)) {
      results = last.results;
      render();
    }

    refresh(false);
  }

  init();
})();
