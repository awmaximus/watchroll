// Página da extensão: lista o que falta assistir e guarda as preferências.
// Conteúdo vindo da API entra sempre por textContent/atributos (nada de innerHTML).

/* global browser, CRApi, CRAnalyzer, CRChecker, CRI18n */
(() => {
  const { t, tn, langName } = CRI18n;
  const UI = CRI18n.lang(); // datas e ordenação seguem a língua do Firefox
  const LANG_CODES = ["pt-BR", "es-419", "es-ES", "en-US", "fr-FR", "de-DE", "it-IT", "ru-RU", "ar-SA", "hi-IN"];
  const LANGS = () => LANG_CODES.map((c) => [c, langName(c)]);
  const MAX_EPS = 5;

  let settings = { ...CRChecker.DEFAULT_SETTINGS };
  let results = [];
  let busy = false;
  let query = "";

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

  const shortMode = (m) => (m === "dub" ? t("shortDub", settings.dubLang) : m === "sub" ? t("shortSub") : t("shortAuto"));

  function fillSelect(select, options, value) {
    select.replaceChildren(...options.map(([v, label]) => el("option", { value: v, text: label })));
    select.value = value;
  }

  function renderSettingsForm() {
    fillSelect($("set-dub"), LANGS(), settings.dubLang);
    fillSelect($("set-sub"), LANGS(), settings.subLang);
    fillSelect(
      $("set-mode"),
      [
        ["sub", t("modeSub")],
        ["dub", t("modeDub")],
        ["auto", t("modeAutoLong")],
      ],
      settings.defaultMode
    );
    fillSelect($("set-locale"), LANGS(), settings.locale);
    const conc = $("set-concurrency");
    conc.min = CRAnalyzer.CONCURRENCY.min;
    conc.max = CRAnalyzer.CONCURRENCY.max;
    conc.value = CRAnalyzer.concurrencyFrom(settings);
    fillSelect(
      $("set-auto"),
      CRChecker.AUTO_CHECK_OPTIONS.map((m) => [
        String(m),
        m === 0 ? t("autoOff") : m < 60 ? t("autoMinutes", m) : m === 60 ? t("autoHour") : t("autoHours", m / 60),
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
  const epLabel = (ep) => (ep.kind === "movie" ? t("epMovie") : t("epLabel", ep.season ?? "?", ep.number || "?"));

  function relTime(ts) {
    if (!ts) return "";
    const diff = Date.now() - ts;
    const day = 86400000;
    if (diff < 0) return "";
    if (diff < 3600000) return t("relNow");
    if (diff < day) return t("relHours", Math.floor(diff / 3600000));
    if (diff < 2 * day) return t("relYesterday");
    if (diff < 30 * day) return t("relDays", Math.floor(diff / day));
    return new Date(ts).toLocaleDateString(UI);
  }

  // Data futura em linguagem natural: "hoje às 14:30", "amanhã às 14:30",
  // "em 3 dias (qui, 16/10)", ou só a data se for mais longe.
  function relFuture(ts, now = Date.now()) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString(UI, { hour: "2-digit", minute: "2-digit" });
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOfDay(d) - startOfDay(new Date(now))) / 86400000);
    if (days <= 0) return t("futToday", time);
    if (days === 1) return t("futTomorrow", time);
    const date = d.toLocaleDateString(UI, { weekday: "short", day: "2-digit", month: "2-digit" });
    if (days < 7) return t("futDays", days, date.replace(".", ""));
    return d.toLocaleDateString(UI, { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  const nextText = (s) =>
    s.next ? t("nextText", epLabel(s.next), relFuture(s.next.at)) : null;

  // ---------- componentes ----------
  function modeSelect(s) {
    const current = settings.seriesModes[s.seriesId] || "";
    const select = el(
      "select",
      { class: "mode", "aria-label": t("modeAria", s.title), title: t("modeTitle") },
      el("option", { value: "", text: t("modeDefault", shortMode(settings.defaultMode)) }),
      el("option", { value: "sub", text: t("modeSub") }),
      el("option", { value: "dub", text: t("modeDubLang", settings.dubLang) }),
      el("option", { value: "auto", text: t("modeAuto") })
    );
    select.value = current;
    select.addEventListener("change", () => changeMode(s, select.value));
    return select;
  }

  // Menu de ações por série. Cada ação: [valor, rótulo, função].
  function seriesActions(s) {
    const diag = ["diag", t("actDiag"), () => exportDiagnostic(s)];
    if (hiddenEntry(s)) return [["show", t("actShow"), () => setHidden(s, null)], diag];
    return [
      ["hide-new", t("actHideNew"), () => setHidden(s, "untilNew")],
      ["hide-week", t("actHideWeek"), () => setHidden(s, "week")],
      ["hide-forever", t("actHideForever"), () => setHidden(s, "forever")],
      diag,
    ];
  }

  const hiddenEntry = (s) => (CRChecker.isHidden(s, settings.hidden[s.seriesId]) ? settings.hidden[s.seriesId] : null);

  function hiddenNote(h) {
    if (h.kind === "week") return t("hiddenUntil", new Date(h.until).toLocaleDateString(UI));
    if (h.kind === "untilNew") return t("hiddenUntilNew");
    return t("hiddenForever");
  }

  async function setHidden(s, kind) {
    if (kind) settings.hidden[s.seriesId] = CRChecker.makeHide(kind, s);
    else delete settings.hidden[s.seriesId];
    await saveSettings();
    render();
    await CRChecker.record(results, { scope: await CRAnalyzer.cacheScope(), settings });
  }

  function actionsSelect(s) {
    const actions = seriesActions(s);
    const select = el(
      "select",
      { class: "actions", "aria-label": t("actionsAria", s.title), title: t("actionsTitle") },
      el("option", { value: "", text: "⋯" }),
      actions.map(([v, label]) => el("option", { value: v, text: label }))
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
        ep.extra ? el("span", { class: "tag", text: ep.extra === "recap" ? t("tagRecap") : t("tagSpecial") }) : null,
        ep.skipped ? el("span", { class: "tag", text: t("tagSkipped") }) : null,
        el("span", { class: "eptitle", text: ep.title || ep.seasonTitle }),
        ep.inProgress
          ? el(
              "span",
              { class: "prog", title: t("watchedPct", Math.round(ep.progress * 100)) },
              el("span", { style: `width:${Math.round(ep.progress * 100)}%` })
            )
          : el("span", { class: "when", text: relTime(ep.availableAt) })
      )
    );
  }

  // Rótulo do card: episódios normais; se só houver extras, diz isso.
  function badgeLabel(s) {
    const main = s.pending.filter((p) => !p.extra && !p.skipped).length;
    if (s.kind === "movie") return s.pending.some((p) => p.inProgress) ? t("badgeContinue") : t("badgeMovie");
    if (main) return tn("badgeNew", main);
    const skipped = s.pending.filter((p) => p.skipped).length;
    if (skipped) return tn("badgeSkipped", skipped);
    return tn("badgeSpecial", s.pending.length);
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
        { class: "thumb", href: watchUrl(first), target: "_blank", rel: "noopener", title: t("watchNext") },
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
          extra > 0 ? el("li", { class: "more", text: tn("moreEps", extra) }) : null
        ),
        el(
          "div",
          { class: "card-foot" },
          modeSelect(s),
          actionsSelect(s),
          s.waitingDub
            ? el("span", { class: "hint", text: t("hintWaitDub", s.waitingDub) })
            : null,
          s.waitingSub
            ? el("span", { class: "hint", text: t("hintWaitSub", s.waitingSub) })
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

  function section(title, count, content, { open = true, id } = {}) {
    if (query.trim()) open = count > 0; // buscando: abre só onde há resultado
    return el(
      "details",
      { class: "section", open: open || null, id },
      el("summary", {}, el("h2", { text: title }), el("span", { class: "count", text: String(count) })),
      content
    );
  }

  // ---------- render ----------
  const byTitle = (a, b) => (a.title || "").localeCompare(b.title || "", UI);

  function render() {
    // Ocultas ficam numa seção própria, fora das demais e das contagens.
    const hidden = results.filter((r) => hiddenEntry(r)).sort(byTitle);
    renderSections(CRChecker.visibleResults(results, settings), hidden);
  }

  // "visible" = resultados sem as séries ocultas. A busca filtra só o que é
  // listado; o status do topo continua contando tudo.
  function renderSections(visible, hiddenAll) {
    const match = (r) => CRChecker.matchesSearch(r.title, query);
    const searching = query.trim() !== "";
    const results = visible.filter(match);
    const hidden = hiddenAll.filter(match);
    const pending = CRChecker.sortPending(
      results.filter((r) => r.status === "pending"),
      settings.sortBy
    );
    // Sem dublagem: a temporada atual não tem nenhum episódio no idioma escolhido
    // (a dublagem pode nunca sair). Aguardando: a dublagem existe e está atrasada.
    const noDub = results.filter((r) => r.status === "uptodate" && r.noDub && r.waitingDub).sort(byTitle);
    const waiting = results.filter((r) => r.status === "uptodate" && !r.noDub && r.waitingDub).sort(byTitle);
    const waitingSub = results.filter((r) => r.status === "uptodate" && !r.waitingDub && r.waitingSub).sort(byTitle);
    const upToDate = results.filter((r) => r.status === "uptodate" && !r.waitingDub && !r.waitingSub).sort(byTitle);
    const never = results.filter((r) => r.status === "never").sort(byTitle);
    const errors = results.filter((r) => r.status === "error").sort(byTitle);

    // Mesma contagem do ícone: sem especiais/recaps (e sem filtro da busca).
    const { episodes: totalEps, series: totalSeries } = CRChecker.summarize(visible);
    $("status").textContent = visible.length
      ? totalEps
        ? t("statusEps", tn("epsCount", totalEps), tn("seriesCount", totalSeries))
        : t("statusAllCaught")
      : "";

    const parts = [];
    parts.push(
      section(
        t("secToWatch"),
        pending.length,
        pending.length
          ? el("div", { class: "grid" }, pending.map(card))
          : el("p", {
              class: "empty",
              text: searching ? t("emptySearch") : t("emptyToWatch"),
            })
      )
    );
    if (waiting.length) {
      parts.push(
        section(
          t("secWaitDub"),
          waiting.length,
          el(
            "ul",
            { class: "rows" },
            waiting.map((s) => row(s, tn("noteWaitDub", s.waitingDub)))
          )
        )
      );
    }
    if (waitingSub.length) {
      parts.push(
        section(
          t("secWaitSub", langName(settings.subLang)),
          waitingSub.length,
          el(
            "ul",
            { class: "rows" },
            waitingSub.map((s) => row(s, tn("noteWaitSub", s.waitingSub)))
          )
        )
      );
    }
    if (noDub.length) {
      parts.push(
        section(
          t("secNoDub", langName(settings.dubLang)),
          noDub.length,
          el(
            "ul",
            { class: "rows" },
            noDub.map((s) =>
              row(
                s,
                tn("noteNoDub", s.waitingDub, settings.dubLang),
                el("button", {
                  class: "btn ghost small",
                  type: "button",
                  text: t("btnSeeSubbed"),
                  title: t("btnSeeSubbedTitle"),
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
          t("secErrors"),
          errors.length,
          el("ul", { class: "rows" }, errors.map((s) => row(s, s.error)))
        )
      );
    }
    parts.push(
      section(
        t("secUpToDate"),
        upToDate.length,
        el(
          "ul",
          { class: "rows" },
          upToDate.map((s) =>
            row(s, s.noDub ? t("noteNoDubSeason", settings.dubLang) : null)
          )
        ),
        { open: false }
      )
    );
    parts.push(
      section(
        t("secNever"),
        never.length,
        el("ul", { class: "rows" }, never.map((s) => row(s, null))),
        { open: false }
      )
    );
    if (hidden.length) {
      parts.push(
        section(
          t("secHidden"),
          hidden.length,
          el(
            "ul",
            { class: "rows" },
            hidden.map((s) =>
              row(
                s,
                hiddenNote(settings.hidden[s.seriesId]),
                el("button", {
                  class: "btn ghost small",
                  type: "button",
                  text: t("btnShow"),
                  onclick: () => setHidden(s, null),
                })
              )
            )
          ),
          { open: false }
        )
      );
    }
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
    $("status").textContent = total ? t("progressChecking", done, total) : t("progressReading");
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
      await CRChecker.record(results, { scope: await CRAnalyzer.cacheScope(), settings });
      showProfile();
    } catch (err) {
      console.error("[Novos Episódios]", err);
      $("status").textContent = "";
      $("content").replaceChildren(
        el(
          "div",
          { class: "error-box" },
          el("p", { text: t("errorQuery", err.message || err) }),
          el("p", { text: t("errorHint") })
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
      const a = el("a", { href: url, download: `${t("diagFile")}-${s.slug || s.seriesId}-${day}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      notice(t("diagSaved", s.title));
    } catch (err) {
      notice(t("diagError", err.message || err));
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
      $("profile").textContent = list.length > 1 && current ? t("profileLabel", current.profile_name) : "";
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
      await CRChecker.record(results, { scope: await CRAnalyzer.cacheScope(), settings });
    } finally {
      await CRApi.release();
      render();
    }
  }

  // ---------- início ----------
  async function init() {
    CRI18n.applyToDocument();
    $("version").textContent = t("versionLabel", browser.runtime.getManifest().version);
    await loadSettings();
    // Remove adiamentos de 1 semana já vencidos.
    const now = Date.now();
    let changed = false;
    for (const [id, h] of Object.entries(settings.hidden)) {
      if (h.kind === "week" && now >= (h.until || 0)) {
        delete settings.hidden[id];
        changed = true;
      }
    }
    if (changed) await saveSettings();
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

    fillSelect(
      $("sort"),
      Object.entries(CRChecker.SORTS).map(([k, key]) => [k, t(key)]),
      settings.sortBy
    );
    $("sort").addEventListener("change", async (e) => {
      settings.sortBy = e.target.value;
      await saveSettings();
      render();
    });
    let searchTimer = null;
    $("search").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        query = e.target.value;
        render();
      }, 120);
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
