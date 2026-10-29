// Página da extensão: lista o que falta assistir e guarda as preferências.
// Conteúdo vindo da API entra sempre por textContent/atributos (nada de innerHTML).

/* global browser, CRApi, CRAnalyzer, CRChecker, CRI18n */
(() => {
  const { t, tn, langName } = CRI18n;
  const UI = CRI18n.lang(); // datas e ordenação seguem a língua do Firefox
  // Áudio e legenda: os idiomas que a Crunchyroll oferece. Títulos e links: só os
  // idiomas do site (outro faria a API devolver em inglês), mais "Automático".
  const byName = (codes) => codes.map((c) => [c, langName(c)]).sort((a, b) => a[1].localeCompare(b[1], UI));
  const MEDIA_LANGS = () => byName(CRI18n.CR_MEDIA_LOCALES);
  const SITE_LANGS = () => [["auto", t("localeAuto")], ...byName(CRI18n.CR_SITE_LOCALES)];
  // Idioma efetivo dos títulos ("auto" → idioma da interface, ou inglês).
  const contentLocale = () => CRI18n.contentLocale(settings.locale, settings.uiLang);
  const MAX_EPS = 5;

  let settings = { ...CRChecker.DEFAULT_SETTINGS };
  let results = [];
  let busy = false;
  let query = "";
  // Estado da aba Pesquisar (sobrevive às re-renderizações da página).
  const searchState = {
    q: "",
    filters: { scope: "all", dub: "any", maxAge: "", year: "", season: "", sort: "default", categories: [], minSeasons: "" },
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
    // Na barra de filtros o texto pode ser cortado: o nome inteiro fica na dica.
    const cur = select.selectedOptions[0];
    select.title = cur ? cur.textContent : "";
  }

  function renderSettingsForm() {
    fillSelect($("set-uilang"), CRI18n.languageOptions(), settings.uiLang || "auto");
    fillSelect($("set-dub"), MEDIA_LANGS(), settings.dubLang);
    fillSelect($("set-sub"), MEDIA_LANGS(), settings.subLang);
    fillSelect(
      $("set-mode"),
      [
        ["sub", t("modeSub")],
        ["dub", t("modeDub")],
        ["auto", t("modeAutoLong")],
      ],
      settings.defaultMode
    );
    fillSelect($("set-locale"), SITE_LANGS(), CRI18n.CR_SITE_LOCALES.includes(settings.locale) ? settings.locale : "auto");
    const conc = $("set-concurrency");
    conc.min = CRAnalyzer.CONCURRENCY.min;
    conc.max = CRAnalyzer.CONCURRENCY.max;
    conc.value = CRAnalyzer.concurrencyFrom(settings);
    const phb = $("set-phbatch");
    phb.min = CRAnalyzer.PLAYHEAD_BATCH.min;
    phb.max = CRAnalyzer.PLAYHEAD_BATCH.max;
    phb.value = CRAnalyzer.playheadBatchFrom(settings);
    const auto = $("set-auto");
    auto.min = 0;
    auto.max = CRChecker.AUTO_CHECK.max;
    auto.value = CRChecker.autoCheckMinutes(settings);
    $("set-notify").checked = settings.notify !== false;
    $("set-openapp-wrap").hidden = !onAndroid;
    $("set-openapp").checked = settings.openInApp !== false;
    $("set-extras").checked = settings.showExtras !== false;
    $("set-skipped").checked = !!settings.showSkipped;
    $("set-anilist").checked = !!settings.anilist;
    $("set-compact").checked = !!settings.compact;
    const ms = $("set-minstarted");
    ms.min = CRAnalyzer.MIN_STARTED.min;
    ms.max = CRAnalyzer.MIN_STARTED.max;
    ms.value = CRAnalyzer.minStartedFrom(settings);
  }

  // ---------- listas (Fila + Crunchylists) ----------
  // available: Crunchylists da conta (null = ainda não lidas).
  const listsState = { available: null, loading: false, error: null };
  const sources = () => CRAnalyzer.listSources(settings);
  const multiList = () => sources().length > 1;

  function listName(id) {
    if (id === CRAnalyzer.WATCHLIST) return t("listWatchlist");
    const found = (listsState.available || []).find((l) => l.id === id);
    return (found && found.title) || settings.listNames[id] || t("listUnknown");
  }

  // Lê os nomes das Crunchylists. Os nomes ficam salvos para os rótulos dos cards
  // aparecerem na hora da próxima vez (e se a leitura falhar).
  async function loadLists() {
    if (listsState.loading) return;
    listsState.loading = true;
    listsState.error = null;
    renderListsField();
    try {
      const list = await CRApi.customLists(contentLocale());
      listsState.available = list;
      const names = { ...settings.listNames };
      let changed = false;
      for (const l of list) {
        if (l.title && names[l.id] !== l.title) {
          names[l.id] = l.title;
          changed = true;
        }
      }
      if (changed) {
        settings.listNames = names;
        await saveSettings();
      }
    } catch (err) {
      console.warn("[Watchroll]", err);
      listsState.error = err.message || String(err);
    } finally {
      listsState.loading = false;
      renderListsField();
      render();
    }
  }

  // Combo de múltipla escolha: um botão com o resumo e um painel de caixas de
  // seleção. A última lista marcada não pode ser desmarcada.
  function renderListsField() {
    const box = $("set-lists");
    if (!box) return;
    const chosen = sources();
    const ids = [CRAnalyzer.WATCHLIST, ...(listsState.available || []).map((l) => l.id)];
    for (const id of chosen) if (!ids.includes(id)) ids.push(id); // escolhida mas não encontrada
    const totalOf = (id) => {
      const l = (listsState.available || []).find((x) => x.id === id);
      return l && typeof l.total === "number" ? l.total : null;
    };
    const wasOpen = box.querySelector(".multi-panel") && !box.querySelector(".multi-panel").hidden;
    const button = el("button", {
      type: "button",
      class: "multi-button",
      id: "set-lists-button",
      "aria-haspopup": "true",
      "aria-expanded": String(!!wasOpen),
      "aria-controls": "set-lists-panel",
      "aria-describedby": "lists-label",
    }, el("span", { class: "multi-summary", text: chosen.map(listName).join(", ") }), el("span", { class: "multi-caret", "aria-hidden": "true", text: "▾" }));
    const panel = el(
      "div",
      { class: "multi-panel", id: "set-lists-panel", role: "group", "aria-labelledby": "lists-label", hidden: !wasOpen },
      ids.map((id) => {
        const checked = chosen.includes(id);
        const n = totalOf(id);
        return el(
          "label",
          { class: "multi-option" },
          el("input", {
            type: "checkbox",
            value: id,
            checked,
            disabled: checked && chosen.length === 1,
            onchange: (e) => changeSources(id, e.target.checked, ids),
          }),
          el("span", { class: "multi-name", text: listName(id) }),
          n == null ? null : el("small", { text: tn("listItems", n) })
        );
      })
    );
    const toggle = (open) => {
      panel.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
    };
    button.addEventListener("click", () => toggle(panel.hidden));
    box.onkeydown = (e) => {
      if (e.key === "Escape" && !panel.hidden) {
        toggle(false);
        button.focus();
      }
    };
    box.replaceChildren(button, panel);

    const status = $("lists-status");
    const msg = listsState.loading ? t("listsLoading") : listsState.error ? t("listsError", listsState.error) : "";
    status.hidden = !msg;
    status.textContent = msg;
    renderHeaderLinks();
  }

  async function changeSources(id, on, order) {
    const set = new Set(sources());
    if (on) set.add(id);
    else if (set.size > 1) set.delete(id);
    settings.sources = order.filter((x) => set.has(x));
    if (!settings.sources.includes(settings.listFilter)) settings.listFilter = "";
    await saveSettings();
    renderListsField();
    // Só as séries novas são analisadas: as demais vêm do cache.
    refresh(false);
  }

  // Rótulos "de que lista veio", só quando há mais de uma lista escolhida.
  function listChips(s, { compact = false } = {}) {
    if (!multiList() || !Array.isArray(s.lists) || !s.lists.length) return null;
    const names = s.lists.filter((id) => sources().includes(id)).map(listName);
    if (!names.length) return null;
    const tip = t("listFrom", names.join(", "));
    return el(
      "span",
      { class: `lists${compact ? " compact" : ""}`, title: tip, "aria-label": tip, role: "note" },
      names.map((n) => el("span", { class: "list-chip", text: n }))
    );
  }

  // ---------- categorias ----------
  // Chave fixa ("action") → nome traduzido; categoria desconhecida ("x:Nome") → o nome
  // que a Crunchyroll mandou.
  const genreLabel = (key) =>
    key.startsWith("x:") ? key.slice(2) : t(`genre_${key}`) || key;
  function genreLine(s, { compact = false } = {}) {
    const keys = Array.isArray(s.genres) ? s.genres : [];
    if (!keys.length) return null;
    const names = keys.map(genreLabel);
    const tip = t("genresTitle", names.join(", "));
    return el("span", { class: `genres${compact ? " compact" : ""}`, title: tip, text: names.join(" · ") });
  }

  // Filtro por categoria: só as categorias das séries que existem (sem as ocultas).
  // Um filtro salvo cuja categoria sumiu vale como "todas".
  function availableGenres() {
    const set = new Set();
    for (const r of results) if (!hiddenEntry(r)) for (const g of r.genres || []) set.add(g);
    return [...set].map((k) => [k, genreLabel(k)]).sort((a, b) => a[1].localeCompare(b[1], UI));
  }
  // Categorias escolhidas que ainda existem nas séries (as que sumiram não filtram).
  // Aceita o formato antigo (uma categoria só, em genreFilter).
  const chosenGenres = () => {
    const saved = Array.isArray(settings.genreFilters)
      ? settings.genreFilters
      : settings.genreFilter
        ? [settings.genreFilter]
        : [];
    return saved.filter((g) => results.some((r) => (r.genres || []).includes(g)));
  };
  const activeGenreFilter = chosenGenres;
  const filtersActive = () =>
    !!(CRChecker.activeListFilter(settings) || chosenGenres().length || CRChecker.activeAudioFilter(settings));

  async function setGenres(list) {
    settings.genreFilters = list;
    delete settings.genreFilter;
    await saveSettings();
    render();
  }

  // ---------- combo de várias escolhas ----------
  // Usado pelos filtros de categoria (abas e Pesquisa). A página é redesenhada a
  // cada mudança: o estado "aberto" fica guardado por id, e o foco volta à opção.
  const openCombos = new Set();
  function multiCombo({ id, labelledBy, options, chosen, allLabel, anyLabel, onChange }) {
    const box = el("div", { class: "multi", id, "data-combo": id });
    const prev = document.getElementById(id);
    const focused =
      prev && document.activeElement && prev.contains(document.activeElement) ? document.activeElement.value : null;
    const open = openCombos.has(id);
    const names = options.filter(([v]) => chosen.includes(v)).map(([, label]) => label);
    const summary = names.length ? names.join(", ") : anyLabel;
    const button = el(
      "button",
      {
        type: "button",
        class: "multi-button",
        "aria-haspopup": "true",
        "aria-expanded": String(open),
        "aria-controls": `${id}-panel`,
        "aria-labelledby": labelledBy,
        title: summary,
      },
      el("span", { class: "multi-summary", text: summary }),
      el("span", { class: "multi-caret", "aria-hidden": "true", text: "▾" })
    );
    const option = (value, label, checked, change, extra = null) =>
      el(
        "label",
        { class: "multi-option" },
        el("input", { type: "checkbox", value, checked, onchange: change }),
        el("span", { class: "multi-name", text: label }),
        extra
      );
    const panel = el(
      "div",
      { class: "multi-panel", id: `${id}-panel`, role: "group", "aria-labelledby": labelledBy, hidden: !open },
      option("", allLabel, !chosen.length, () => onChange([])),
      options.map(([v, label, count]) =>
        option(
          v,
          label,
          chosen.includes(v),
          (e) => onChange(e.target.checked ? [...chosen, v] : chosen.filter((x) => x !== v)),
          count == null ? null : el("small", { text: String(count) })
        )
      )
    );
    const toggle = (on) => {
      panel.hidden = !on;
      button.setAttribute("aria-expanded", String(on));
      if (on) openCombos.add(id);
      else openCombos.delete(id);
    };
    button.addEventListener("click", () => toggle(panel.hidden));
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.hidden) {
        toggle(false);
        button.focus();
      }
    });
    box.append(button, panel);
    if (focused !== null) {
      queueMicrotask(() => {
        const again = [...panel.querySelectorAll("input")].find((i) => i.value === focused);
        if (again) again.focus();
      });
    }
    return box;
  }

  function renderGenreFilter(genres) {
    const chosen = chosenGenres();
    const count = (k) => results.filter((r) => !hiddenEntry(r) && (r.genres || []).includes(k)).length;
    $("genre-filter").replaceWith(
      multiCombo({
        id: "genre-filter",
        labelledBy: "genre-filter-label",
        options: genres.map(([k, label]) => [k, label, count(k)]),
        chosen,
        allLabel: t("genreFilterAll"),
        anyLabel: t("genreFilterAny"),
        onChange: setGenres,
      })
    );
  }

  function renderFilters() {
    const genres = availableGenres();
    $("genrefilter-wrap").hidden = !genres.length;
    if (genres.length) renderGenreFilter(genres);
    // Filtro em uso fica destacado; "Limpar filtros" só aparece com algum em uso.
    $("listfilter-wrap").classList.toggle("active", !!CRChecker.activeListFilter(settings));
    $("genrefilter-wrap").classList.toggle("active", chosenGenres().length > 0);
    $("audiofilter-wrap").classList.toggle("active", !!CRChecker.activeAudioFilter(settings));
    $("clear-filters").hidden = !(filtersActive() || query.trim());
    fillSelect(
      $("audio-filter"),
      [["", t("audioFilterAll")], ["sub", t("modeSub")], ["dub", t("modeDub")], ["auto", t("modeAuto")]],
      CRChecker.activeAudioFilter(settings)
    );
  }

  function renderListFilter() {
    const wrap = $("listfilter-wrap");
    wrap.hidden = !multiList();
    if (wrap.hidden) return;
    fillSelect(
      $("list-filter"),
      [["", t("listFilterAny")], ...sources().map((id) => [id, listName(id)])],
      CRChecker.activeListFilter(settings)
    );
  }

  // ---------- exportar / importar configurações ----------
  // O arquivo leva só preferências (modos por série, ocultas, listas…): nada de
  // token, cookie ou resultado de verificação.
  const BACKUP_TYPE = "crnovos-settings";
  function exportSettings() {
    const data = {
      type: BACKUP_TYPE,
      format: 1,
      extensionVersion: browser.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      settings,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: `crnovos-settings-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Aceita só as chaves conhecidas, com o mesmo tipo do valor padrão.
  function settingsFromBackup(text) {
    const data = JSON.parse(text);
    if (!data || data.type !== BACKUP_TYPE || !data.settings || typeof data.settings !== "object") {
      throw new Error("not a settings file");
    }
    const out = {};
    for (const [k, def] of Object.entries(CRChecker.DEFAULT_SETTINGS)) {
      const v = data.settings[k];
      if (v === undefined) continue;
      const kind = (x) => (Array.isArray(x) ? "array" : x === null ? "null" : typeof x);
      if (kind(v) === kind(def)) out[k] = v;
    }
    return out;
  }

  async function importSettings(file) {
    try {
      const imported = settingsFromBackup(await file.text());
      settings = { ...CRChecker.DEFAULT_SETTINGS, ...imported };
      await saveSettings();
      location.reload(); // abre já com o idioma e as listas importadas
    } catch (err) {
      console.warn("[Watchroll] import failed:", err);
      notice(t("importError", file.name)); // arquivo inválido ou de outro programa
    }
  }

  // ---------- nota da Crunchyroll ----------
  // Uma consulta por série, guardada por 24 h (a nota muda devagar). As notas são
  // buscadas depois da verificação e dos resultados da Pesquisa, sem atrasar a lista.
  const RATINGS_KEY = "crnovos:ratings";
  const RATING_TTL = 24 * 3600000;
  const RATING_KEEP = 30 * 86400000; // entradas sem uso há 30 dias saem do armazenamento
  let ratings = {}; // id -> { average, total, at } | { none: true, at }
  const ratingQueue = new Map(); // id -> "series" | "movie"
  let ratingsRunning = false;

  async function loadRatings() {
    try {
      ratings = (await browser.storage.local.get(RATINGS_KEY))[RATINGS_KEY] || {};
    } catch (_) {
      ratings = {};
    }
  }

  // items: [{ id, kind, inline }]. Pede só as notas que não vieram junto com a lista
  // e que faltam ou passaram de 24 h.
  function wantRatings(items) {
    const now = Date.now();
    for (const { id, kind, inline } of items) {
      if (!id || inline) continue;
      const r = ratings[id];
      if (!r || now - (r.at || 0) > RATING_TTL) ratingQueue.set(id, kind === "movie" ? "movie" : "series");
    }
    if (ratingQueue.size && !ratingsRunning && !busy) fetchRatings();
  }

  async function fetchRatings() {
    ratingsRunning = true;
    try {
      while (ratingQueue.size && !busy) {
        const batch = [...ratingQueue.entries()].slice(0, 50);
        for (const [id] of batch) ratingQueue.delete(id);
        let next = 0;
        const worker = async () => {
          while (next < batch.length) {
            const [id, kind] = batch[next++];
            try {
              const r = await CRApi.rating(id, kind);
              ratings[id] = r ? { ...r, at: Date.now() } : { none: true, at: Date.now() };
            } catch (err) {
              // 404: o título não tem página de notas. Outros erros: tenta de novo outra vez.
              if (err && err.status === 404) ratings[id] = { none: true, at: Date.now() };
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(CRAnalyzer.concurrencyFrom(settings), batch.length) }, worker));
        render();
      }
      const now = Date.now();
      for (const [id, r] of Object.entries(ratings)) if (now - (r.at || 0) > RATING_KEEP) delete ratings[id];
      try {
        await browser.storage.local.set({ [RATINGS_KEY]: ratings });
      } catch (_) {}
    } finally {
      ratingsRunning = false;
      if (!busy) await CRApi.release();
    }
  }

  const ratingItems = (list) =>
    list.map((s) => ({ id: s.seriesId || s.id, kind: s.kind === "movie" || s.type === "movie" ? "movie" : "series", inline: !!s.rating }));

  // s: resultado da verificação ou da Pesquisa. Primeiro a nota que veio junto.
  function ratingBadge(s, { compact = false } = {}) {
    const r = s.rating || ratings[s.seriesId || s.id];
    if (!r || r.none) return null;
    const avg = r.average.toLocaleString(UI, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const tip = t("ratingTitle", avg, r.total.toLocaleString(UI));
    return el("span", { class: `rating${compact ? " compact" : ""}`, title: tip, "aria-label": tip, role: "img" }, el("span", { class: "star", "aria-hidden": "true", text: "★" }), avg);
  }

  // ---------- links ----------
  // Mesmo formato de link do site: /pt-br, /es, /fr…; en-US sem prefixo.
  const prefix = () => CRI18n.sitePath(contentLocale());
  // Links do cabeçalho para o site: início, Fila e as Crunchylists escolhidas
  // nas Configurações (no idioma dos títulos e links).
  function renderHeaderLinks() {
    const nav = $("cr-links");
    if (!nav) return;
    const base = `https://www.crunchyroll.com${prefix()}`;
    const link = (href, text, extra = {}) =>
      el("a", { class: "cr-link", href, target: "_blank", rel: "noopener", text, title: text, ...extra });
    const lists = sources()
      .filter((id) => id !== CRAnalyzer.WATCHLIST)
      .map((id) => link(`${base}/crunchylists/${encodeURIComponent(id)}`, listName(id), { class: "cr-link list" }));
    nav.replaceChildren(link(`${base}/`, t("linkHome")), link(`${base}/watchlist`, t("listWatchlist")), ...lists);
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

  // Lançamento nas próximas 6 horas: contagem regressiva ("em 45 min", "em 3 h (14:30)").
  const SOON = 6 * 3600000;
  const isSoon = (s, now = Date.now()) => !!(s.next && s.next.at > now && s.next.at - now < SOON);
  function relSoon(ts, now = Date.now()) {
    const d = ts - now;
    if (d <= 0 || d >= SOON) return null;
    if (d < 3600000) return t("futInMinutes", Math.max(1, Math.ceil(d / 60000)));
    const time = new Date(ts).toLocaleTimeString(UI, { hour: "2-digit", minute: "2-digit" });
    return t("futInHours", Math.floor(d / 3600000), time);
  }
  // "~" marca o horário previsto pelo ritmo semanal (a Crunchyroll não informou).
  const approx = (next) => (next && next.estimated ? "~" : "");
  const nextText = (s, now = Date.now()) =>
    s.next
      ? t("nextText", epLabel(s.next), approx(s.next) + (relSoon(s.next.at, now) || relFuture(s.next.at, now)))
      : null;

  // A contagem regressiva dos cards é atualizada a cada minuto, sem redesenhar a página.
  function tickSoon() {
    for (const n of document.querySelectorAll(".hint.next[data-series]")) {
      const s = results.find((r) => r.seriesId === n.dataset.series);
      if (!s || !s.next) continue;
      n.textContent = nextText(s);
      n.classList.toggle("soon", isSoon(s));
    }
  }

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

  // Ícones de traço das abas (Pesquisa e Configurações); o nome fica no title/aria-label.
  function tabIcon(paths) {
    const svg = document.createElementNS(SVG, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", "aria-hidden": "true", class: "tab-icon" })) svg.setAttribute(k, v);
    for (const d of paths) {
      const p = document.createElementNS(SVG, "path");
      p.setAttribute("d", d);
      svg.append(p);
    }
    return svg;
  }
  const searchIcon = () => tabIcon(["M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M15.5 15.5 21 21"]);

  function gearIcon() {
    return tabIcon([
      "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
      "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
    ]);
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
        el("div", { class: "badges" }, ratingBadge(s), dubBadge(s), listChips(s)),
        genreLine(s),
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
          s.next
            ? el("span", { class: `hint next${isSoon(s) ? " soon" : ""}`, "data-series": s.seriesId, text: nextText(s) })
            : null
        )
      )
    );
  }

  function row(s, note, extraButton = null, { withNext = true } = {}) {
    note = [note, withNext ? nextText(s) : null].filter(Boolean).join(" · ");
    return el(
      "li",
      { class: "row", "data-series": s.seriesId },
      s.image ? el("img", { src: s.image, alt: "", loading: "lazy" }) : el("span", { class: "noimg" }),
      el(
        "div",
        { class: "row-text" },
        el("span", { class: "row-title" }, el("a", { href: seriesUrl(s), target: "_blank", rel: "noopener", text: s.title }), ratingBadge(s, { compact: true }), dubBadge(s, { compact: true }), listChips(s, { compact: true }), genreLine(s, { compact: true })),
        note ? el("small", { text: note, title: note }) : null
      ),
      el("div", { class: "row-actions" }, extraButton, modeSelect(s), actionsSelect(s))
    );
  }

  // "Para assistir" em modo compacto: uma linha por série, com o botão ▶ para o
  // próximo episódio.
  function compactRow(s) {
    const first = s.pending.find((p) => !p.extra && !p.skipped) || s.pending[0];
    const note = [badgeLabel(s), first ? [epLabel(first), first.title].filter(Boolean).join(" ") : null]
      .filter(Boolean)
      .join(" · ");
    const play = first
      ? el("a", { class: "btn small play-btn", href: watchUrl(first), target: "_blank", rel: "noopener", title: t("watchNext"), "aria-label": t("watchNext"), text: "▶" })
      : null;
    return row(s, note, play);
  }

  // ---------- aba Semana ----------
  // Próximos lançamentos dos 7 dias seguintes, por dia (o próximo episódio de cada série).
  const WEEK_MS = 7 * 86400000;
  const startOfDay = (ts) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const upcomingWeek = (list, now = Date.now()) =>
    list.filter((r) => r.next && r.next.at > now && r.next.at - now <= WEEK_MS).sort((a, b) => a.next.at - b.next.at);

  function dayTitle(ts, now = Date.now()) {
    const days = Math.round((startOfDay(ts) - startOfDay(now)) / 86400000);
    if (days <= 0) return t("calToday");
    if (days === 1) return t("calTomorrow");
    const txt = new Date(ts).toLocaleDateString(UI, { weekday: "long", day: "numeric", month: "long" });
    return txt.charAt(0).toLocaleUpperCase(UI) + txt.slice(1);
  }

  function weekPanel(list) {
    if (!list.length) return el("p", { class: "empty", text: t("emptyCalendar") });
    const legend = list.some((s) => s.next.estimated) ? [el("p", { class: "hint cal-note", text: t("calEstimatedNote") })] : [];
    const days = new Map();
    for (const s of list) {
      const k = startOfDay(s.next.at);
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(s);
    }
    return [...legend, ...[...days.entries()].map(([k, items]) =>
      el(
        "section",
        { class: "group" },
        el("h3", {}, el("span", { text: dayTitle(k) }), el("span", { class: "count", text: String(items.length) })),
        el(
          "ul",
          { class: "rows" },
          items.map((s) => {
            const time = approx(s.next) + new Date(s.next.at).toLocaleTimeString(UI, { hour: "2-digit", minute: "2-digit" });
            const soon = relSoon(s.next.at) && approx(s.next) + relSoon(s.next.at);
            const note = [time, epLabel(s.next), s.next.title, soon].filter(Boolean).join(" · ");
            return row(s, note, null, { withNext: false });
          })
        )
      )
    )];
  }

  // ---------- abas ----------
  // Cada seção é uma aba. A escolhida fica salva (settings.tab). Durante uma busca,
  // se a aba atual não tiver resultado, mostra a primeira que tiver (sem salvar).
  function renderTabs(tabs) {
    const shown = tabs.filter((tb) => tb.always || tb.count > 0);
    const searching = query.trim() !== "" || filtersActive();
    let active = shown.find((tb) => tb.id === settings.tab) || shown[0];
    if (searching && active.count === 0) active = shown.find((tb) => tb.count > 0) || active;
    const sorts = CRChecker.TAB_SORTS[active.id];
    $("sort-wrap").hidden = !sorts || sorts.length < 2;
    if (sorts) fillSelect($("sort"), sorts.map((k) => [k, t(CRChecker.SORTS[k])]), CRChecker.sortFor(settings, active.id));
    $("sort").dataset.tab = active.id;
    $("toolbar").hidden = active.id === "search" || active.id === "settings";
    $("group-wrap").hidden = active.id !== "never";
    $("group-never").checked = settings.groupNever !== false;
    // As Configurações são um painel fixo da página (os campos guardam estado e
    // ouvintes): a aba só o mostra ou esconde.
    $("settings").hidden = active.id !== "settings";
    if (active.id === "settings" && !listsState.available && !listsState.loading && !listsState.error && !busy) {
      loadLists().finally(() => CRApi.release());
    }

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
            title: tb.icon ? tb.label : null,
            "aria-label": tb.icon ? tb.label : null,
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
          tb.icon ? tb.icon() : el("span", { text: tb.label }),
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
    CRSearch.seasons(contentLocale())
      .then((list) => (searchState.seasons = list))
      .catch((err) => {
        console.warn("[Watchroll]", err);
        searchState.seasons = [];
      })
      .finally(() => {
        searchState.seasonsLoading = false;
        if (settings.tab === "search") render();
      });
  }

  // Categorias para o filtro da Pesquisa (da Crunchyroll; se falhar, a lista fixa).
  function loadCategories() {
    if (searchState.categories || searchState.categoriesLoading) return;
    searchState.categoriesLoading = true;
    CRSearch.categories(contentLocale())
      .then((list) => (searchState.categories = list))
      .finally(() => {
        searchState.categoriesLoading = false;
        if (settings.tab === "search") render();
      });
  }
  const categoryLabel = (c) => (c.key && !c.key.startsWith("x:") ? genreLabel(c.key) : c.title);

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
      console.error("[Watchroll]", err);
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
          ratingBadge(r),
          r.age == null ? null : el("span", { class: `age age-${r.age}`, text: r.age === 0 ? "L" : String(r.age), title: r.age === 0 ? t("ageFree") : t("ageMin", r.age) }),
          dubBadge(s),
          r.inWatchlist ? el("span", { class: "in-list", text: t("searchInList") }) : null
        ),
        meta.length ? el("small", { class: "result-meta", text: meta.join(" · ") }) : null,
        genreLine(r)
      )
    );
  }

  function searchPanel() {
    loadSeasons();
    loadCategories();
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
        el(
          "button",
          { class: `btn${st.loading ? " is-loading" : ""}`, type: "submit", disabled: st.loading || null, "aria-busy": st.loading ? "true" : null },
          st.loading ? el("span", { class: "spinner small", "aria-hidden": "true" }) : null,
          el("span", { text: t("searchButton") })
        )
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
          "div",
          { class: "search-field-multi" },
          el("span", { id: "sf-cat-label", text: t("genreFilterLabel") }),
          multiCombo({
            id: "sf-cat",
            labelledBy: "sf-cat-label",
            options: (searchState.categories || [])
              .map((c) => [c.id, categoryLabel(c)])
              .sort((a, b) => a[1].localeCompare(b[1], UI)),
            chosen: f.categories || [],
            allLabel: t("genreFilterAll"),
            anyLabel: searchState.categories ? t("genreFilterAny") : t("searchLoading"),
            onChange: (list) => {
              f.categories = list;
              runSearch();
            },
          })
        ),
        el(
          "label",
          {},
          el("span", { text: t("searchMinSeasons") }),
          el(
            "select",
            { id: "sf-minseasons", onchange: onFilter("minSeasons") },
            opt("", t("searchAny"), f.minSeasons),
            ["2", "3", "4", "5", "6"].map((n) => opt(n, t("searchAtLeast", n), f.minSeasons))
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
          el("span", { text: t("searchSeason") }),
          el(
            "select",
            { id: "sf-season", onchange: onFilter("season"), disabled: !st.seasons || null },
            opt("", st.seasons ? t("searchAny") : t("searchLoading"), f.season),
            (st.seasons || []).map((s) => opt(s.id, s.title, f.season))
          )
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
      if (st.loading) {
        // Indicador animado + cartões "fantasma" no lugar dos resultados.
        const msg = catalogMode ? t("searchLoadingCatalog") : t("searchLoading");
        parts.push(
          el(
            "div",
            { class: "search-loading", role: "status", "aria-live": "polite" },
            el("span", { class: "spinner", "aria-hidden": "true" }),
            el("span", { text: msg })
          ),
          el(
            "div",
            { class: "results skeletons", "aria-hidden": "true" },
            Array.from({ length: 6 }, () =>
              el(
                "div",
                { class: "result skeleton" },
                el("span", { class: "sk-thumb" }),
                el("span", { class: "sk-lines" }, el("span", { class: "sk-line" }), el("span", { class: "sk-line short" }))
              )
            )
          )
        );
      } else {
        parts.push(el("p", { class: "empty", text: t("searchHint") }));
      }
    } else {
      parts.push(el("p", { class: "result-count", text: tn("searchCount", st.items.length) }));
      if (st.items.length) {
        const visible = st.items.slice(0, st.shown);
        parts.push(el("div", { class: "results" }, visible.map(resultCard)));
        wantRatings(ratingItems(visible));
      }
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
          el("ul", { class: "rows" }, g.items.map((s) => row(s, statsNote(s))))
        )
      );
  }

  // "3 temporadas · 36 episódios" (nada para filmes ou sem a informação).
  function statsNote(s) {
    const st = s.stats;
    if (!st) return null;
    return [
      typeof st.seasons === "number" ? tn("searchSeasons", st.seasons) : null,
      typeof st.episodes === "number" ? tn("epsCount", st.episodes) : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;
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
    const listFilter = CRChecker.activeListFilter(settings);
    const genreFilter = activeGenreFilter();
    const audioFilter = CRChecker.activeAudioFilter(settings);
    const match = (r) =>
      CRChecker.matchesSearch(r.title, query) &&
      CRChecker.inList(r, listFilter) &&
      CRChecker.hasGenre(r, genreFilter) &&
      CRChecker.hasAudio(r, audioFilter);
    const searching = query.trim() !== "" || filtersActive();
    renderListFilter();
    renderFilters();
    const results = visible.filter(match);
    const hidden = hiddenAll.filter(match);
    const by = (tab) => CRChecker.sortFor(settings, tab);
    const sorted = (tab, list) => CRChecker.sortResults(list, by(tab));
    const pending = sorted("toWatch", results.filter((r) => r.status === "pending"));
    // Sem dublagem: a temporada atual não tem nenhum episódio no idioma escolhido
    // (a dublagem pode nunca sair). Aguardando: a dublagem existe e está atrasada.
    const noDub = sorted("noDub", results.filter((r) => r.status === "uptodate" && r.noDub && r.waitingDub));
    const waiting = sorted("waitDub", results.filter((r) => r.status === "uptodate" && !r.noDub && r.waitingDub));
    // Sem legenda: nenhum episódio lançado da temporada atual tem legenda no seu idioma
    // (pode nunca sair). Legenda pendente: a legenda existe e está atrasada.
    const noSub = sorted("noSub", results.filter((r) => r.status === "uptodate" && !r.waitingDub && r.noSub && r.waitingSub));
    const waitingSub = sorted("waitSub", results.filter((r) => r.status === "uptodate" && !r.waitingDub && !r.noSub && r.waitingSub));
    const upToDate = sorted("upToDate", results.filter((r) => r.status === "uptodate" && !r.waitingDub && !r.waitingSub));
    const never = sorted("never", results.filter((r) => r.status === "never"));
    const errors = sorted("errors", results.filter((r) => r.status === "error"));
    const week = upcomingWeek(results);
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
            ? settings.compact
              ? el("ul", { class: "rows one-col" }, pending.map(compactRow))
              : el("div", { class: "grid" }, pending.map(card))
            : el("p", { class: "empty", text: searching ? t("emptySearch") : t("emptyToWatch") }),
      },
      { id: "waitDub", label: t("secWaitDub"), count: waiting.length, content: () => rows(waiting, (s) => tn("noteWaitDub", s.waitingDub)) },
      {
        id: "waitSub",
        label: t("secWaitSub"),
        count: waitingSub.length,
        content: () => rows(waitingSub, (s) => tn("noteWaitSub", s.waitingSub)),
      },
      {
        id: "noDub",
        label: t("secNoDub"),
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
        id: "noSub",
        label: t("secNoSub"),
        count: noSub.length,
        content: () =>
          el(
            "ul",
            { class: "rows" },
            noSub.map((s) =>
              row(
                s,
                tn("noteNoSub", s.waitingSub, langName(settings.subLang || settings.dubLang)),
                el("button", {
                  class: "btn ghost small",
                  type: "button",
                  text: t("btnSeeAnyAudio"),
                  title: t("btnSeeAnyAudioTitle"),
                  onclick: () => changeMode(s, "auto"),
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
      { id: "week", label: t("secCalendar"), count: week.length, always: true, content: () => weekPanel(week) },
      {
        id: "never",
        label: t("secNever"),
        count: never.length,
        always: true,
        content: () =>
          !never.length
            ? el("p", { class: "empty", text: searching ? t("emptySearch") : t("emptyNever") })
            : settings.groupNever !== false
            ? neverGroups(never) // dentro de cada grupo, a ordem escolhida
            : rows(never, statsNote),
      },
      { id: "errors", label: t("secErrors"), count: errors.length, content: () => rows(errors, (s) => s.error) },
      { id: "search", label: t("secSearch"), count: null, always: true, icon: searchIcon, content: searchPanel },
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
      { id: "settings", label: t("btnSettings"), count: null, always: true, icon: gearIcon, content: () => null },
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
      showUpdated(Date.now());
      showElapsed(performance.now() - t0);
      // O que está na tela conta como visto: não vira notificação depois.
      await CRChecker.record(results, { scope: await CRAnalyzer.cacheScope(), settings });
      showProfile();
      await loadLists();
    } catch (err) {
      console.error("[Watchroll]", err);
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
      wantRatings(ratingItems(results)); // notas que faltam, depois da verificação
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

  // Data e hora da última atualização (desta página ou da verificação em segundo plano).
  function showUpdated(at) {
    const n = $("updated");
    if (!at) {
      n.textContent = "";
      return;
    }
    const d = new Date(at);
    const sameDay = d.toDateString() === new Date().toDateString();
    const when = sameDay
      ? d.toLocaleTimeString(UI, { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString(UI, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    n.textContent = t("statusUpdatedAt", when);
    n.title = d.toLocaleString(UI, { dateStyle: "full", timeStyle: "medium" });
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
  // ---------- Firefox para Android: abrir no app da Crunchyroll ----------
  // Um link "intent://" com o pacote do app faz o Android abrir o app oficial; sem o
  // app instalado, o Firefox segue para o endereço normal (browser_fallback_url).
  // O app usa o idioma dele: o prefixo de idioma (/pt-br, /es…) sai do caminho.
  const CR_APP = "com.crunchyroll.crunchyroid";
  let onAndroid = false;
  function appIntent(href) {
    const u = new URL(href);
    const path = u.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/|$)/i, "") || "/";
    return `intent://${u.host}${path}${u.search}#Intent;scheme=https;package=${CR_APP};S.browser_fallback_url=${encodeURIComponent(href)};end`;
  }
  function openInAppHandler(e) {
    if (!onAndroid || settings.openInApp === false || e.defaultPrevented || e.button) return;
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    let u;
    try {
      u = new URL(a.href);
    } catch (_) {
      return;
    }
    if (u.protocol !== "https:" || u.hostname !== "www.crunchyroll.com") return;
    e.preventDefault();
    location.href = appIntent(a.href);
  }

  async function init() {
    await loadSettings();
    try {
      onAndroid = (await browser.runtime.getPlatformInfo()).os === "android";
    } catch (_) {
      onAndroid = /Android/i.test(navigator.userAgent);
    }
    document.documentElement.classList.toggle("android", onAndroid);
    document.addEventListener("click", openInAppHandler, true);
    await loadRatings();
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
    renderListsField(); // também desenha os links do cabeçalho
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
    // Outro idioma de títulos: a Pesquisa e as temporadas são lidas de novo nele.
    $("set-locale").addEventListener("change", async (e) => {
      searchState.items = null;
      searchState.seasons = null;
      await onSetting("locale")(e);
    });
    $("set-auto").addEventListener("change", async (e) => {
      settings.autoCheckMinutes = CRChecker.autoCheckMinutes({ autoCheckMinutes: e.target.value });
      e.target.value = settings.autoCheckMinutes;
      await saveSettings(); // o segundo plano reagenda ao ver a mudança
    });
    $("set-openapp").addEventListener("change", async (e) => {
      settings.openInApp = e.target.checked;
      await saveSettings();
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
    $("set-compact").addEventListener("change", async (e) => {
      settings.compact = e.target.checked;
      await saveSettings();
      render();
    });
    $("btn-export").addEventListener("click", exportSettings);
    $("btn-import").addEventListener("click", () => $("import-file").click());
    $("import-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) importSettings(f);
    });
    setInterval(tickSoon, 60000);
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
    $("group-never").addEventListener("change", async (e) => {
      settings.groupNever = e.target.checked;
      await saveSettings();
      render();
    });
    $("list-filter").addEventListener("change", async (e) => {
      settings.listFilter = e.target.value;
      await saveSettings();
      render();
    });
    $("clear-filters").addEventListener("click", async () => {
      settings.listFilter = "";
      settings.genreFilters = [];
      delete settings.genreFilter;
      settings.audioFilter = "";
      query = "";
      $("search").value = "";
      await saveSettings();
      render();
      $("search").focus();
    });
    $("audio-filter").addEventListener("change", async (e) => {
      settings.audioFilter = e.target.value;
      await saveSettings();
      render();
    });
    // Fecha os combos de categorias ao tocar/clicar fora deles.
    document.addEventListener("click", (e) => {
      if (!document.contains(e.target)) return; // elemento já redesenhado
      for (const box of document.querySelectorAll(".multi[data-combo]")) {
        const panel = box.querySelector(".multi-panel");
        if (panel && !panel.hidden && !box.contains(e.target)) {
          panel.hidden = true;
          box.querySelector(".multi-button").setAttribute("aria-expanded", "false");
          openCombos.delete(box.dataset.combo);
        }
      }
    });
    // Fecha o combo de listas ao clicar fora dele.
    document.addEventListener("click", (e) => {
      const box = $("set-lists");
      const panel = box && box.querySelector(".multi-panel");
      if (panel && !panel.hidden && !box.contains(e.target)) {
        panel.hidden = true;
        box.querySelector(".multi-button").setAttribute("aria-expanded", "false");
      }
    });
    let searchTimer = null;
    $("search").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        query = e.target.value;
        render();
      }, 120);
    });

    // A verificação em segundo plano achou algo com a página aberta: mostra na hora
    // e avisa quantos episódios novos apareceram.
    browser.storage.onChanged.addListener((changes, area) => {
      const c = area === "local" && changes[CRChecker.LAST_KEY];
      if (!c || !c.newValue || !Array.isArray(c.newValue.results) || busy) return;
      const keys = (list) => new Set(CRChecker.pendingItems(CRChecker.visibleResults(list, settings)).map((i) => i.key));
      const before = keys(results);
      const fresh = [...keys(c.newValue.results)].filter((k) => !before.has(k)).length;
      results = c.newValue.results;
      render();
      showUpdated(c.newValue.at);
      $("elapsed").textContent = ""; // a duração mostrada era a da atualização anterior
      if (fresh) notice(tn("notifTitle", fresh));
    });

    // Mostra na hora o último resultado conhecido enquanto atualiza.
    const last = await CRChecker.lastResults();
    if (last && Array.isArray(last.results)) {
      results = last.results;
      showUpdated(last.at);
    }
    // Sempre desenha as abas: mesmo sem resultado (ou se a verificação falhar), as
    // Configurações e a Pesquisar ficam acessíveis.
    render();

    refresh(false);
  }

  init();
})();
