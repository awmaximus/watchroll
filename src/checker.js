// Partes compartilhadas entre a página e o segundo plano:
//  - preferências (valores padrão e leitura);
//  - contagem de episódios para o ícone;
//  - "o que é novo desde a última vez" e a notificação correspondente;
//  - a verificação completa usada pelo alarme.

/* global browser, CRI18n */
var CRChecker = (() => {
  const { t, tn } = CRI18n;
  const SETTINGS_KEY = "crnovos:settings";
  const LAST_KEY = "crnovos:last"; // último resultado completo (a página mostra na hora)
  const SEEN_KEY = "crnovos:seen"; // episódios pendentes já mostrados ou notificados
  const NOTIFICATION_ID = "crnovos-novos";
  const AUTO_CHECK_OPTIONS = [0, 30, 60, 180, 360]; // minutos; 0 = desligado

  const DEFAULT_SETTINGS = {
    locale: "pt-BR",
    dubLang: "pt-BR",
    subLang: "pt-BR",
    defaultMode: "sub",
    concurrency: 4,
    playheadBatch: 100,
    autoCheckMinutes: 60,
    notify: true,
    showExtras: true,
    showSkipped: false,
    minStartedSeconds: 60,
    seriesModes: {},
    hidden: {}, // seriesId -> { kind: "untilNew" | "week" | "forever", at, until?, seen? }
    sortBy: "released",
    sortByTab: {},
    tab: "toWatch",
    anilist: false,
    uiLang: "auto",
    sources: ["watchlist"], // "watchlist" (a Fila) e/ou IDs de Crunchylists
    listNames: {}, // ID da Crunchylist -> nome (o último lido da API)
    listFilter: "", // filtro das abas: "" = todas as listas
  };

  async function loadSettings(b = browser) {
    const saved = (await b.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      seriesModes: { ...(saved.seriesModes || {}) },
      hidden: { ...(saved.hidden || {}) },
      sources: Array.isArray(saved.sources) && saved.sources.length ? [...saved.sources] : [...DEFAULT_SETTINGS.sources],
      listNames: { ...(saved.listNames || {}) },
    };
  }
  const saveSettings = (settings, b = browser) => b.storage.local.set({ [SETTINGS_KEY]: settings });

  function autoCheckMinutes(settings) {
    const m = Number(settings && settings.autoCheckMinutes);
    return AUTO_CHECK_OPTIONS.includes(m) ? m : DEFAULT_SETTINGS.autoCheckMinutes;
  }

  // Episódios que contam como "novos" (os marcados como extra/pulado ficam de fora).
  function pendingItems(results) {
    return (results || [])
      .filter((r) => r.status === "pending")
      .flatMap((r) =>
        r.pending
          .filter((p) => !p.extra && !p.skipped)
          .map((p) => ({ key: `${r.seriesId}:${p.id}`, series: r, ep: p }))
      );
  }

  // ---------- ocultar / adiar ----------
  const WEEK = 7 * 86400000;
  const mainPendingIds = (r) =>
    r && r.status === "pending" ? r.pending.filter((p) => !p.extra && !p.skipped).map((p) => p.id) : [];

  function makeHide(kind, result, now = Date.now()) {
    if (kind === "week") return { kind, at: now, until: now + WEEK };
    if (kind === "untilNew") return { kind, at: now, seen: mainPendingIds(result) };
    return { kind: "forever", at: now };
  }

  // A série está oculta agora? "untilNew" volta quando aparece um episódio que não
  // estava pendente na hora de ocultar; "week" volta depois de 7 dias.
  function isHidden(result, h, now = Date.now()) {
    if (!h) return false;
    if (h.kind === "forever") return true;
    if (h.kind === "week") return now < (h.until || 0);
    if (h.kind === "untilNew") {
      const seen = new Set(h.seen || []);
      return !mainPendingIds(result).some((id) => !seen.has(id));
    }
    return false;
  }

  // Filtro por lista das abas. Um filtro que aponta para uma lista que não está
  // mais entre as escolhidas vale como "todas".
  function activeListFilter(settings) {
    const f = settings && settings.listFilter;
    const sources = (settings && settings.sources) || [];
    return f && sources.length > 1 && sources.includes(f) ? f : "";
  }
  const inList = (r, listId) => !listId || (Array.isArray(r.lists) ? r.lists.includes(listId) : listId === "watchlist");

  const visibleResults = (results, settings, now = Date.now()) =>
    (results || []).filter((r) => !isHidden(r, ((settings && settings.hidden) || {})[r.seriesId], now));

  // ---------- busca e ordenação ----------
  const fold = (t) =>
    String(t || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

  // Todas as palavras da busca precisam aparecer no título (sem acento/caixa).
  function matchesSearch(title, query) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const t = fold(title);
    return words.every((w) => t.includes(w));
  }

  // Ordenações: valor -> chave da tradução do rótulo.
  const SORTS = {
    released: "sortReleased",
    watched: "sortWatched",
    count: "sortCount",
    title: "sortTitle",
    waiting: "sortWaiting",
    next: "sortNext",
    season: "sortSeason",
  };
  // Ordenações que fazem sentido em cada aba (a primeira é a padrão).
  const TAB_SORTS = {
    toWatch: ["released", "watched", "count", "title"],
    waitDub: ["waiting", "watched", "title"],
    waitSub: ["waiting", "watched", "title"],
    noDub: ["waiting", "watched", "title"],
    upToDate: ["watched", "next", "title"],
    never: ["season", "title"],
    errors: ["title"],
    hidden: ["title", "watched"],
  };
  const SEASON_RANK = { winter: 0, spring: 1, summer: 2, fall: 3 };
  const launchRank = (r) => (r.launch ? r.launch.year * 10 + (SEASON_RANK[r.launch.season] ?? 0) : -1);
  const waitingCount = (r) => (r.waitingDub || 0) + (r.waitingSub || 0);
  const nextAt = (r) => (r.next && r.next.at) || Infinity;

  // Ordenação escolhida para a aba (salva por aba; "Para assistir" herda a antiga sortBy).
  function sortFor(settings, tab) {
    const allowed = TAB_SORTS[tab] || ["title"];
    const saved = (settings.sortByTab || {})[tab] || (tab === "toWatch" ? settings.sortBy : null);
    return allowed.includes(saved) ? saved : allowed[0];
  }

  function sortResults(list, by) {
    const cmp = {
      released: (a, b) => newestRelease(b) - newestRelease(a) || byTitle(a, b),
      watched: (a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0) || byTitle(a, b),
      count: (a, b) => mainCount(b) - mainCount(a) || byTitle(a, b),
      waiting: (a, b) => waitingCount(b) - waitingCount(a) || byTitle(a, b),
      next: (a, b) => nextAt(a) - nextAt(b) || byTitle(a, b),
      season: (a, b) => launchRank(b) - launchRank(a) || byTitle(a, b),
      title: byTitle,
    }[by] || byTitle;
    return [...list].sort(cmp);
  }
  const mainCount = (r) => (r.pending || []).filter((p) => !p.extra && !p.skipped).length;
  const newestRelease = (r) => Math.max(0, ...(r.pending || []).map((p) => p.availableAt || 0));
  const byTitle = (a, b) => (a.title || "").localeCompare(b.title || "", CRI18n.lang());

  function sortPending(list, by) {
    const cmp = {
      released: (a, b) => newestRelease(b) - newestRelease(a) || byTitle(a, b),
      watched: (a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0) || byTitle(a, b),
      count: (a, b) => mainCount(b) - mainCount(a) || byTitle(a, b),
      title: byTitle,
    }[by] || ((a, b) => newestRelease(b) - newestRelease(a) || byTitle(a, b));
    return [...list].sort(cmp);
  }

  function summarize(results) {
    const items = pendingItems(results);
    return { episodes: items.length, series: new Set(items.map((i) => i.series.seriesId)).size };
  }

  const badgeText = (n) => (n <= 0 ? "" : n > 99 ? "99+" : String(n));

  async function updateBadge(results, b = browser) {
    const { episodes, series } = summarize(results);
    await b.action.setBadgeText({ text: badgeText(episodes) });
    await b.action.setBadgeBackgroundColor({ color: "#ff640a" });
    if (b.action.setBadgeTextColor) await b.action.setBadgeTextColor({ color: "#000000" });
    await b.action.setTitle({
      title: episodes
        ? t("badgeTitleSome", episodes, tn("seriesCount", series))
        : t("badgeTitleNone"),
    });
  }

  function notificationText(fresh) {
    const bySeries = new Map();
    for (const i of fresh) {
      const list = bySeries.get(i.series.seriesId) || { title: i.series.title, eps: [] };
      list.eps.push(i.ep.kind === "movie" ? t("notifMovie") : t("epLabel", i.ep.season ?? "?", i.ep.number || "?"));
      bySeries.set(i.series.seriesId, list);
    }
    const lines = [...bySeries.values()].map((s) => `${s.title}: ${s.eps.join(", ")}`);
    const shown = lines.slice(0, 4);
    if (lines.length > shown.length) shown.push(t("notifMore", lines.length - shown.length));
    return {
      title: tn("notifTitle", fresh.length),
      message: shown.join("\n"),
    };
  }

  /**
   * Guarda o resultado, atualiza o ícone e devolve os episódios que não tinham
   * aparecido antes. Na primeira vez (nada guardado), só registra: não há "novo".
   * Com notify, mostra uma notificação dos novos (se a preferência permitir).
   */
  async function record(results, { notify = false, settings = DEFAULT_SETTINGS, scope = "", b = browser } = {}) {
    // Séries ocultas não contam no ícone nem geram notificação.
    const visible = visibleResults(results, settings);
    const items = pendingItems(visible);
    // "Já visto" é por perfil (scope): trocar de perfil não notifica os episódios
    // do outro perfil. Formato antigo (lista simples) vale como escopo "".
    let all = (await b.storage.local.get(SEEN_KEY))[SEEN_KEY];
    if (Array.isArray(all)) all = { "": all };
    all = all || {};
    const stored = all[scope];
    const prev = new Set(stored || []);
    const fresh = stored ? items.filter((i) => !prev.has(i.key)) : [];
    all[scope] = items.map((i) => i.key);
    await b.storage.local.set({
      [SEEN_KEY]: all,
      [LAST_KEY]: { at: Date.now(), results, scope },
    });
    await updateBadge(visible, b);
    if (notify && settings.notify !== false && fresh.length && b.notifications) {
      const { title, message } = notificationText(fresh);
      await b.notifications.create(NOTIFICATION_ID, {
        type: "basic",
        iconUrl: b.runtime.getURL("icons/icon-96.png"),
        title,
        message,
      });
    }
    return fresh;
  }

  // ---------- alerta na hora do lançamento ----------
  // A análise já sabe quando sai o próximo episódio de cada série (r.next). Em vez de
  // esperar a verificação periódica (até 1 hora depois), o segundo plano agenda uma
  // verificação logo após o lançamento. A Crunchyroll às vezes libera com atraso: um
  // episódio que já devia ter saído e ainda não apareceu é conferido de novo a cada
  // 10 minutos, por até 3 horas.
  const RELEASE_KEY = "crnovos:releases";
  const RELEASE_DELAY = 3 * 60000;
  const RELEASE_RETRY = 10 * 60000;
  const RELEASE_GIVE_UP = 3 * 3600000;

  const releaseKey = (e) => `${e.seriesId}:${e.id}`;
  const isOut = (results, e) => {
    const r = results.find((x) => x.seriesId === e.seriesId);
    return !r || (r.pending || []).some((p) => p.id === e.id);
  };

  // Devolve { when, watch }: o horário da próxima verificação extra (ou null) e a
  // lista de lançamentos acompanhados (guardar para a próxima chamada).
  function planReleases(results, previous = [], settings = DEFAULT_SETTINGS, now = Date.now()) {
    const visible = visibleResults(results, settings, now);
    const upcoming = visible
      .filter((r) => r.next && r.next.at > now)
      .map((r) => ({ seriesId: r.seriesId, id: r.next.id, at: r.next.at }));
    const late = (previous || []).filter(
      (e) => e && e.at <= now && now - e.at < RELEASE_GIVE_UP && visible.some((r) => r.seriesId === e.seriesId) && !isOut(visible, e)
    );
    const watch = [...new Map([...late, ...upcoming].map((e) => [releaseKey(e), e])).values()];
    const times = [
      ...upcoming.map((e) => e.at + RELEASE_DELAY),
      ...(late.length ? [now + RELEASE_RETRY] : []),
    ];
    const when = times.length ? Math.max(now + 60000, Math.min(...times)) : null;
    return { when, watch };
  }

  // Os alertas na hora do lançamento seguem as mesmas chaves da verificação
  // automática: notificação ligada e verificação automática ligada.
  const releaseAlertsOn = (settings) => settings.notify !== false && autoCheckMinutes(settings) > 0;

  async function nextReleaseCheck(results, settings, { b = browser, now = Date.now() } = {}) {
    const previous = (await b.storage.local.get(RELEASE_KEY))[RELEASE_KEY] || [];
    const { when, watch } = planReleases(results, previous, settings, now);
    await b.storage.local.set({ [RELEASE_KEY]: watch });
    return releaseAlertsOn(settings) ? when : null;
  }

  async function lastResults(b = browser) {
    return (await b.storage.local.get(LAST_KEY))[LAST_KEY] || null;
  }

  // Verificação completa usada pelo alarme do segundo plano.
  let running = null;
  function checkNow({ analyzer, api, b = browser }) {
    if (running) return running;
    running = (async () => {
      const settings = await loadSettings(b);
      // Notificação e dica do ícone no idioma escolhido pelo usuário.
      if (CRI18n.init) await CRI18n.init(settings.uiLang || "auto");
      try {
        const results = await analyzer.run({ settings });
        const scope = analyzer.cacheScope ? await analyzer.cacheScope() : "";
        const fresh = await record(results, { notify: true, settings, scope, b });
        return { ok: true, results, fresh };
      } catch (err) {
        // Sem sessão, sem aba para a ponte, offline...: tenta de novo no próximo alarme.
        console.warn("[Novos Episódios] verificação automática falhou:", err);
        return { ok: false, error: String(err.message || err) };
      } finally {
        if (api && api.release) await api.release();
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    SETTINGS_KEY,
    LAST_KEY,
    SEEN_KEY,
    RELEASE_KEY,
    planReleases,
    nextReleaseCheck,
    releaseAlertsOn,
    NOTIFICATION_ID,
    AUTO_CHECK_OPTIONS,
    DEFAULT_SETTINGS,
    loadSettings,
    saveSettings,
    autoCheckMinutes,
    pendingItems,
    summarize,
    matchesSearch,
    activeListFilter,
    inList,
    SORTS,
    TAB_SORTS,
    sortFor,
    sortResults,
    sortPending,
    makeHide,
    isHidden,
    visibleResults,
    badgeText,
    updateBadge,
    notificationText,
    record,
    lastResults,
    checkNow,
  };
})();
