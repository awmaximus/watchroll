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
  // Estado da aba Pesquisar (sobrevive às re-renderizações da página).
  const searchState = {
    q: "",
    filters: { scope: "all", dub: "any", maxAge: "", year: "", season: "", sort: "default" },
    items: null,
    shown: 60, // resultados visíveis; "Carregar mais" mostra mais 60
    loading: false,
    error: null,
    anilist: null,
    seasons: null,
    seasonsLoading: false,
  };

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
    fillSelect($("set-uilang"), CRI18n.languageOptions(), settings.uiLang || "auto");
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
    const phb = $("set-phbatch");
    phb.min = CRAnalyzer.PLAYHEAD_BATCH.min;
    phb.max = CRAnalyzer.PLAYHEAD_BATCH.max;
    phb.value = CRAnalyzer.playheadBatchFrom(settings);
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
    $("set-anilist").checked = !!settings.anilist;
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

  // Ícone de microfone com a situação da dublagem no idioma escolhido.
  const SVG = "http://www.w3.org/2000/svg";
  function micIcon(crossed) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    const parts = [
      ["rect", { x: "9", y: "3", width: "6", height: "11", rx: "3" }],
      ["path", { d: "M5.5 11a6.5 6.5 0 0 0 13 0" }],
      ["path", { d: "M12 17.5V21M8.5 21h7" }],
    ];
    if (crossed) parts.push(["path", { d: "M4 4l16 16" }]);
    for (const [tag, attrs] of parts) {
      const n = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      svg.append(n);
    }
    return svg;
  }

  function dubBadge(s, { compact = false } = {}) {
    const st = CRAnalyzer.dubStatus(s, settings.dubLang);
    if (!st) return null;
    const name = langName(settings.dubLang);
    const tip = st === "yes" ? t("dubYes", name) : st === "old" ? t("dubOld", name) : t("dubNo", name);
    return el(
      "span",
      { class: `dub dub-${st}${compact ? " compact" : ""}`, title: tip, "aria-label": tip, role: "img" },
      micIcon(st === "no"),
      compact ? null : el("span", { text: settings.dubLang })
    );
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
        dubBadge(s),
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
        el("span", { class: "row-title" }, el("a", { href: seriesUrl(s), target: "_blank", rel: "noopener", text: s.title }), dubBadge(s, { compact: true })),
        note ? el("small", { text: note, title: note }) : null
      ),
      el("div", { class: "row-actions" }, extraButton, modeSelect(s), actionsSelect(s))
    );
  }

  // ---------- abas ----------
  // Cada seção é uma aba. A escolhida fica salva (settings.tab). Durante uma busca,
  // se a aba atual não tiver resultado, mostra a primeira que tiver (sem salvar).
  function renderTabs(tabs) {
    const shown = tabs.filter((tb) => tb.always || tb.count > 0);
    const searching = query.trim() !== "";
    let active = shown.find((tb) => tb.id === settings.tab) || shown[0];
    if (searching && active.count === 0) active = shown.find((tb) => tb.count > 0) || active;
    const sorts = CRChecker.TAB_SORTS[active.id];
    $("sort-wrap").hidden = !sorts || sorts.length < 2;
    if (sorts) fillSelect($("sort"), sorts.map((k) => [k, t(CRChecker.SORTS[k])]), CRChecker.sortFor(settings, active.id));
    $("sort").dataset.tab = active.id;
    $("toolbar").hidden = active.id === "search" || active.id === "settings";
    // As Configurações são um painel fixo da página (os campos guardam estado e
    // ouvintes): a aba só o mostra ou esconde.
    $("settings").hidden = active.id !== "settings";

    const select = async (id) => {
      settings.tab = id;
      await saveSettings();
      render();
      const btn = document.querySelector(`.tabs [data-tab="${id}"]`);
      if (btn) btn.focus();
    };
    const nav = el(
      "nav",
      { class: "tabs", role: "tablist", "aria-label": t("tabsAria") },
      shown.map((tb) =>
        el(
          "button",
          {
            type: "button",
            class: "tab",
            role: "tab",
            id: `tab-${tb.id}`,
            "data-tab": tb.id,
            "aria-selected": String(tb.id === active.id),
            "aria-controls": tb.id === "settings" ? "settings" : "tabpanel",
            tabindex: tb.id === active.id ? "0" : "-1",
            onclick: () => select(tb.id),
            onkeydown: (e) => {
              const i = shown.indexOf(tb);
              const go = (j) => {
                e.preventDefault();
                select(shown[(j + shown.length) % shown.length].id);
              };
              if (e.key === "ArrowRight") go(i + 1);
              else if (e.key === "ArrowLeft") go(i - 1);
              else if (e.key === "Home") go(0);
              else if (e.key === "End") go(shown.length - 1);
            },
          },
          el("span", { text: tb.label }),
          tb.count == null ? null : el("span", { class: "count", text: String(tb.count) })
        )
      )
    );
    const panel =
      active.id === "settings"
        ? null
        : el(
            "section",
            { class: "tabpanel", id: "tabpanel", role: "tabpanel", "aria-labelledby": `tab-${active.id}` },
            active.content()
          );
    // Re-renderizar não pode tirar o cursor de um campo em edição (ex.: a busca).
    const focused = document.activeElement && document.activeElement.id;
    const sel = focused && "selectionStart" in document.activeElement ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    $("tabbar").replaceChildren(nav);
    $("content").replaceChildren(...(panel ? [panel] : []));
    if (focused && focused !== "content") {
      const again = document.getElementById(focused);
      if (again && again !== document.body) {
        again.focus();
        if (sel && again.setSelectionRange) {
          try {
            again.setSelectionRange(sel[0], sel[1]);
          } catch (_) {}
        }
      }
    }
  }

  // ---------- aba Pesquisar ----------
  const RATING_OPTIONS = ["", "0", "10", "12", "14", "16", "18"];
  const watchIds = () => new Set(results.map((r) => r.seriesId));
  const resultUrl = (r) =>
    r.type === "movie"
      ? `https://www.crunchyroll.com${prefix()}/search?q=${encodeURIComponent(r.title)}`
      : `https://www.crunchyroll.com${prefix()}/series/${r.id}/${r.slug || ""}`;

  async function anilistAllowed() {
    if (!settings.anilist) return false;
    try {
      return await browser.permissions.contains({ data_collection: ["searchTerms"] });
    } catch (_) {
      return true; // Firefox sem permissões de coleta de dados: vale a opção
    }
  }

  // Pede a permissão de enviar o texto da busca ao AniList (precisa de um clique).
  async function enableAniList() {
    let ok = true;
    try {
      ok = await browser.permissions.request({ data_collection: ["searchTerms"] });
    } catch (_) {
      ok = true;
    }
    settings.anilist = !!ok;
    await saveSettings();
    $("set-anilist").checked = settings.anilist;
    return settings.anilist;
  }

  function loadSeasons() {
    if (searchState.seasons || searchState.seasonsLoading) return;
    searchState.seasonsLoading = true;
    CRSearch.seasons(settings.locale)
      .then((list) => (searchState.seasons = list))
      .catch((err) => {
        console.warn("[Novos Episódios]", err);
        searchState.seasons = [];
      })
      .finally(() => {
        searchState.seasonsLoading = false;
        if (settings.tab === "search") render();
      });
  }

  async function runSearch() {
    if (searchState.loading) return;
    searchState.loading = true;
    searchState.error = null;
    searchState.items = null;
    searchState.shown = CRSearch.PAGE;
    render();
    try {
      const r = await CRSearch.run({
        q: searchState.q,
        filters: searchState.filters,
        settings,
        watchIds: watchIds(),
        useAniList: await anilistAllowed(),
        uiLang: CRI18n.lang(),
      });
      searchState.items = r.items;
      searchState.anilist = r.anilist;
    } catch (err) {
      console.error("[Novos Episódios]", err);
      searchState.error = t("searchError", err.message || err);
    } finally {
      searchState.loading = false;
      await CRApi.release();
      render();
    }
  }

  function resultCard(r) {
    const s = { audios: { latest: r.audios, any: r.audios } };
    const meta = [
      r.type === "movie" ? t("searchMovie") : r.seasons ? tn("searchSeasons", r.seasons) : null,
      r.year ? String(r.year) : null,
    ].filter(Boolean);
    return el(
      "article",
      { class: "result" },
      el(
        "a",
        { class: "result-thumb", href: resultUrl(r), target: "_blank", rel: "noopener", tabindex: "-1", "aria-hidden": "true" },
        r.image ? el("img", { src: r.image, alt: "", loading: "lazy" }) : null
      ),
      el(
        "div",
        { class: "result-info" },
        el("a", { class: "series", href: resultUrl(r), target: "_blank", rel: "noopener", text: r.title, title: r.title }),
        el(
          "div",
          { class: "result-tags" },
          r.age == null ? null : el("span", { class: `age age-${r.age}`, text: r.age === 0 ? "L" : String(r.age), title: r.age === 0 ? t("ageFree") : t("ageMin", r.age) }),
          dubBadge(s),
          r.inWatchlist ? el("span", { class: "in-list", text: t("searchInList") }) : null
        ),
        meta.length ? el("small", { class: "result-meta", text: meta.join(" · ") }) : null
      )
    );
  }

  function searchPanel() {
    loadSeasons();
    const st = searchState;
    const f = st.filters;
    const name = langName(settings.dubLang);
    const opt = (v, label, cur) => el("option", { value: v, text: label, selected: String(cur) === String(v) || null });
    const now = new Date().getFullYear();
    const years = Array.from({ length: now + 1 - 1970 + 1 }, (_, i) => String(now + 1 - i));
    const onFilter = (key) => (e) => {
      f[key] = e.target.value;
      runSearch();
    };

    const form = el(
      "form",
      {
        class: "search-form",
        role: "search",
        onsubmit: (e) => {
          e.preventDefault();
          runSearch();
        },
      },
      el(
        "div",
        { class: "search-line" },
        el("input", {
          id: "sq",
          type: "search",
          value: st.q,
          placeholder: t("searchQueryPlaceholder"),
          "aria-label": t("searchQueryPlaceholder"),
          autocomplete: "off",
          oninput: (e) => (st.q = e.target.value),
        }),
        el("button", { class: "btn", type: "submit", text: t("searchButton"), disabled: st.loading || null })
      ),
      el(
        "div",
        { class: "search-filters" },
        el(
          "label",
          {},
          el("span", { text: t("searchScope") }),
          el("select", { id: "sf-scope", onchange: onFilter("scope") }, opt("all", t("searchScopeAll"), f.scope), opt("mine", t("searchScopeMine"), f.scope))
        ),
        el(
          "label",
          {},
          el("span", { text: t("searchDub") }),
          el(
            "select",
            { id: "sf-dub", onchange: onFilter("dub") },
            opt("any", t("searchDubAny"), f.dub),
            opt("dub", t("searchDubYes", name), f.dub),
            opt("nodub", t("searchDubNo", name), f.dub)
          )
        ),
        el(
          "label",
          {},
          el("span", { text: t("searchAge") }),
          el(
            "select",
            { id: "sf-age", onchange: onFilter("maxAge") },
            RATING_OPTIONS.map((v) => opt(v, v === "" ? t("searchAgeAny") : v === "0" ? t("ageFree") : t("searchAgeUpTo", v), f.maxAge))
          )
        ),
        el(
          "label",
          {},
          el("span", { text: t("searchYear") }),
          el("select", { id: "sf-year", onchange: onFilter("year") }, opt("", t("searchAny"), f.year), years.map((y) => opt(y, y, f.year)))
        ),
        el(
          "label",
          {},
          el("span", { text: t("searchSort") }),
          el(
            "select",
            { id: "sf-sort", onchange: onFilter("sort") },
            opt("default", t("searchSortDefault"), f.sort),
            opt("year", t("searchSortYear"), f.sort),
            opt("title", t("searchSortTitle"), f.sort)
          )
        ),
        el(
          "label",
          {},
          el("span", { text: t("searchSeason") }),
          el(
            "select",
            { id: "sf-season", onchange: onFilter("season"), disabled: !st.seasons || null },
            opt("", st.seasons ? t("searchAny") : t("searchLoading"), f.season),
            (st.seasons || []).map((s) => opt(s.id, s.title, f.season))
          )
        )
      )
    );

    const parts = [form];
    if (CRSearch.hasCJK(st.q) && st.anilist === "off") {
      parts.push(
        el(
          "p",
          { class: "notice-inline" },
          el("span", { text: t("searchNeedAniList") }),
          el("button", {
            class: "btn ghost small",
            type: "button",
            text: t("searchEnableAniList"),
            onclick: async () => {
              if (await enableAniList()) runSearch();
            },
          })
        )
      );
    } else if (st.anilist === "error") {
      parts.push(el("p", { class: "notice-inline", text: t("searchAniListError") }));
    }
    if (f.scope === "mine" && !results.length) parts.push(el("p", { class: "empty", text: t("searchMineEmpty") }));

    if (st.error) parts.push(el("div", { class: "error-box" }, el("p", { text: st.error })));
    else if (st.items === null) {
      const catalogMode = !st.q.trim() && !f.season && f.scope !== "mine";
      parts.push(
        el("p", { class: "empty", text: st.loading ? (catalogMode ? t("searchLoadingCatalog") : t("searchLoading")) : t("searchHint") })
      );
    } else {
      parts.push(el("p", { class: "result-count", text: tn("searchCount", st.items.length) }));
      if (st.items.length) parts.push(el("div", { class: "results" }, st.items.slice(0, st.shown).map(resultCard)));
      if (st.items.length > st.shown) {
        parts.push(
          el("button", {
            class: "btn ghost more-btn",
            type: "button",
            text: t("searchMore"),
            onclick: () => {
              st.shown += CRSearch.PAGE;
              render();
            },
          })
        );
      }
    }
    return el("div", { class: "search" }, parts);
  }

  // "Ainda não começadas" em grupos pela temporada de lançamento (outono 2026,
  // verão 2026…), da mais recente para a mais antiga; sem etiqueta vai por último.
  const SEASON_ORDER = { winter: 0, spring: 1, summer: 2, fall: 3 };
  const SEASON_KEYS = { winter: "seasonWinter", spring: "seasonSpring", summer: "seasonSummer", fall: "seasonFall" };
  function neverGroups(list) {
    const groups = new Map();
    for (const s of list) {
      const l = s.launch;
      const key = l ? `${l.year}-${SEASON_ORDER[l.season]}` : "none";
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          rank: l ? l.year * 10 + SEASON_ORDER[l.season] : -1,
          title: l ? t("seasonLabel", t(SEASON_KEYS[l.season]), l.year) : t("seasonUnknown"),
          items: [],
        });
      }
      groups.get(key).items.push(s);
    }
    return [...groups.values()]
      .sort((a, b) => b.rank - a.rank)
      .map((g) =>
        el(
          "section",
          { class: "group" },
          el("h3", {}, el("span", { text: g.title }), el("span", { class: "count", text: String(g.items.length) })),
          el("ul", { class: "rows" }, g.items.map((s) => row(s, null)))
        )
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
    const by = (tab) => CRChecker.sortFor(settings, tab);
    const sorted = (tab, list) => CRChecker.sortResults(list, by(tab));
    const pending = sorted("toWatch", results.filter((r) => r.status === "pending"));
    // Sem dublagem: a temporada atual não tem nenhum episódio no idioma escolhido
    // (a dublagem pode nunca sair). Aguardando: a dublagem existe e está atrasada.
    const noDub = sorted("noDub", results.filter((r) => r.status === "uptodate" && r.noDub && r.waitingDub));
    const waiting = sorted("waitDub", results.filter((r) => r.status === "uptodate" && !r.noDub && r.waitingDub));
    const waitingSub = sorted("waitSub", results.filter((r) => r.status === "uptodate" && !r.waitingDub && r.waitingSub));
    const upToDate = sorted("upToDate", results.filter((r) => r.status === "uptodate" && !r.waitingDub && !r.waitingSub));
    const never = sorted("never", results.filter((r) => r.status === "never"));
    const errors = sorted("errors", results.filter((r) => r.status === "error"));
    const hiddenSorted = sorted("hidden", hidden);

    // Mesma contagem do ícone: sem especiais/recaps (e sem filtro da busca).
    const { episodes: totalEps, series: totalSeries } = CRChecker.summarize(visible);
    $("status").textContent = visible.length
      ? totalEps
        ? t("statusEps", tn("epsCount", totalEps), tn("seriesCount", totalSeries))
        : t("statusAllCaught")
      : "";

    const rows = (list, note) => el("ul", { class: "rows" }, list.map((s) => row(s, note(s))));
    renderTabs([
      {
        id: "toWatch",
        label: t("secToWatch"),
        count: pending.length,
        always: true,
        content: () =>
          pending.length
            ? el("div", { class: "grid" }, pending.map(card))
            : el("p", { class: "empty", text: searching ? t("emptySearch") : t("emptyToWatch") }),
      },
      { id: "waitDub", label: t("secWaitDub"), count: waiting.length, content: () => rows(waiting, (s) => tn("noteWaitDub", s.waitingDub)) },
      {
        id: "waitSub",
        label: t("secWaitSub", langName(settings.subLang)),
        count: waitingSub.length,
        content: () => rows(waitingSub, (s) => tn("noteWaitSub", s.waitingSub)),
      },
      {
        id: "noDub",
        label: t("secNoDub", langName(settings.dubLang)),
        count: noDub.length,
        content: () =>
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
          ),
      },
      {
        id: "upToDate",
        label: t("secUpToDate"),
        count: upToDate.length,
        always: true,
        content: () => rows(upToDate, (s) => (s.noDub ? t("noteNoDubSeason", settings.dubLang) : null)),
      },
      {
        id: "never",
        label: t("secNever"),
        count: never.length,
        always: true,
        content: () =>
          !never.length
            ? el("p", { class: "empty", text: t("emptyNever") })
            : by("never") === "season"
            ? neverGroups(never)
            : rows(never, () => null),
      },
      { id: "errors", label: t("secErrors"), count: errors.length, content: () => rows(errors, (s) => s.error) },
      { id: "search", label: t("secSearch"), count: null, always: true, content: searchPanel },
      {
        id: "hidden",
        label: t("secHidden"),
        count: hidden.length,
        content: () =>
          el(
            "ul",
            { class: "rows" },
            hiddenSorted.map((s) =>
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
      },
      { id: "settings", label: t("btnSettings"), count: null, always: true, content: () => null },
    ]);
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
      $("elapsed").textContent = "";
      const t0 = performance.now();
      results = await CRAnalyzer.run({ settings, force, onProgress: setProgress });
      render();
      showElapsed(performance.now() - t0);
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
  function showElapsed(ms) {
    const secs = (ms / 1000).toLocaleString(CRI18n.lang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    $("elapsed").textContent = t("statusElapsed", secs);
  }

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
    await loadSettings();
    // Idioma da interface: o escolhido nas Configurações, ou o do navegador.
    await CRI18n.init(settings.uiLang || "auto");
    CRI18n.applyToDocument();
    $("version").textContent = t("versionLabel", browser.runtime.getManifest().version);
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
    // Trocar o idioma recarrega a página, que já abre traduzida.
    $("set-uilang").addEventListener("change", async (e) => {
      settings.uiLang = e.target.value;
      await saveSettings();
      location.reload();
    });
    $("set-anilist").addEventListener("change", async (e) => {
      if (e.target.checked) await enableAniList();
      else {
        settings.anilist = false;
        await saveSettings();
      }
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
    // Também só muda a velocidade, não o resultado: vale na próxima verificação.
    $("set-phbatch").addEventListener("change", async (e) => {
      settings.playheadBatch = CRAnalyzer.playheadBatchFrom({ playheadBatch: e.target.value });
      e.target.value = settings.playheadBatch;
      await saveSettings();
    });

    $("sort").addEventListener("change", async (e) => {
      const id = e.target.dataset.tab || "toWatch";
      settings.sortByTab = { ...(settings.sortByTab || {}), [id]: e.target.value };
      if (id === "toWatch") settings.sortBy = e.target.value;
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
    if (last && Array.isArray(last.results)) results = last.results;
    // Sempre desenha as abas: mesmo sem resultado (ou se a verificação falhar), as
    // Configurações e a Pesquisar ficam acessíveis.
    render();

    refresh(false);
  }

  init();
})();
