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
  // Verificação automática, em minutos: 0 desliga; fora disso, de 5 a 1440 (1 dia).
  const AUTO_CHECK = { default: 60, min: 5, max: 1440 };

  const DEFAULT_SETTINGS = {
    locale: "auto", // idioma dos títulos e links: "auto" = idioma da interface
    dubLang: "", // vazio = ainda não escolhido: segue o idioma da interface
    subLang: "",
    defaultMode: "sub",
    concurrency: 4,
    playheadBatch: 100,
    autoCheckMinutes: AUTO_CHECK.default,
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
    genreFilters: [], // filtro das abas por categorias (qualquer uma delas); vazio = todas
    audioFilter: "", // filtro das abas por modo de áudio (sub/dub/auto): "" = todos
    openInApp: true, // Firefox para Android: links da Crunchyroll abrem no app
    compact: false, // "Para assistir" em linhas em vez de cards
    groupNever: true, // "A iniciar" agrupado pela temporada de lançamento
  };

  // ---------- preferências: locais + sincronizadas (storage.sync) ----------
  // As preferências ficam no storage.local (leitura rápida, e o resto da extensão
  // reage às mudanças ali) e também no storage.sync, que o navegador leva para os
  // outros computadores da mesma conta (Firefox Sync, sincronização do Chrome).
  //
  //  - O storage.sync aceita no máximo 8 KB por item e ~100 KB no total: o JSON das
  //    preferências é dividido em pedaços (crnovos:sync:0, :1…) e o item
  //    crnovos:sync:meta diz quantos são, o tamanho e um checksum. Pedaços que ainda
  //    não chegaram todos (ou de versões diferentes) não batem com o checksum e são
  //    ignorados até completar.
  //  - O que é estado da tela de um aparelho (aba aberta, filtros, nomes das listas
  //    lidos da API) não é sincronizado.
  //  - Vale a versão mais nova (data da gravação). Na primeira vez que um aparelho
  //    encontra preferências no sync, os modos por série e as séries ocultas dos dois
  //    lados são somados, para não perder nada do que já existia.
  //  - Sem storage.sync (ou com erro), tudo continua funcionando só com o local.
  const SETTINGS_AT_KEY = "crnovos:settingsAt"; // quando as preferências locais mudaram
  const SYNCED_AT_KEY = "crnovos:syncedAt"; // versão do sync que este aparelho já tem
  const SYNC_PREFIX = "crnovos:sync:";
  const SYNC_META = SYNC_PREFIX + "meta";
  const LOCAL_ONLY = ["tab", "listFilter", "genreFilters", "audioFilter", "listNames"];
  const SYNC_ITEM_BYTES = 8192 - 64; // margem para o nome da chave
  const SYNC_TOTAL_BYTES = 102400 - 2048;

  function syncArea(b) {
    try {
      const area = b && b.storage && b.storage.sync;
      return area && typeof area.get === "function" && typeof area.set === "function" ? area : null;
    } catch (_) {
      return null;
    }
  }

  const syncedPart = (settings) =>
    Object.fromEntries(Object.entries(settings || {}).filter(([k]) => !LOCAL_ONLY.includes(k)));
  const localPart = (settings) =>
    Object.fromEntries(Object.entries(settings || {}).filter(([k]) => LOCAL_ONLY.includes(k)));

  // Bytes de um caractere dentro de uma string JSON (UTF-8, com os escapes).
  function jsonCharBytes(ch) {
    if (ch === '"' || ch === "\\") return 2;
    const c = ch.codePointAt(0);
    if (c < 0x20) return 6;
    if (c < 0x80) return 1;
    if (c < 0x800) return 2;
    if (c < 0x10000) return 3;
    return 4;
  }
  const jsonBytes = (text) => {
    let n = 2; // aspas
    for (const ch of text) n += jsonCharBytes(ch);
    return n;
  };

  /** Divide o texto em pedaços que, gravados como string JSON, cabem em um item. */
  function chunkText(text, limit = SYNC_ITEM_BYTES) {
    const chunks = [];
    let cur = "";
    let size = 2;
    for (const ch of text) {
      const cost = jsonCharBytes(ch);
      if (cur && size + cost > limit) {
        chunks.push(cur);
        cur = "";
        size = 2;
      }
      cur += ch;
      size += cost;
    }
    chunks.push(cur);
    return chunks;
  }

  // FNV-1a de 32 bits: só para saber se os pedaços formam o texto certo.
  function checksum(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  /** Preferências guardadas no sync: { data, at, text }; null se vazio; { incomplete: true }
   *  se os pedaços ainda estão chegando de outro aparelho (ou não deu para ler). */
  async function readSync(b = browser) {
    const area = syncArea(b);
    if (!area) return null;
    try {
      const all = (await area.get(null)) || {};
      const meta = all[SYNC_META];
      if (!meta || !Number.isInteger(meta.n) || meta.n < 1) return null;
      let text = "";
      for (let i = 0; i < meta.n; i++) {
        const part = all[SYNC_PREFIX + i];
        if (typeof part !== "string") return { incomplete: true }; // ainda chegando
        text += part;
      }
      if (text.length !== meta.len || checksum(text) !== meta.sum) return { incomplete: true };
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) return { incomplete: true };
      return { data, at: Number(meta.at) || 0, text };
    } catch (err) {
      console.warn("[Watchroll] não deu para ler as preferências sincronizadas:", err);
      return { incomplete: true };
    }
  }

  // Último texto gravado/lido no sync por este contexto: evita regravar o mesmo.
  let syncedText = null;

  /** Grava a parte sincronizável das preferências no sync. Devolve true se gravou. */
  async function pushSync(settings, at, b = browser) {
    const area = syncArea(b);
    if (!area) return false;
    const text = JSON.stringify(syncedPart(settings));
    if (text === syncedText) return true;
    const chunks = chunkText(text);
    const meta = { n: chunks.length, len: text.length, sum: checksum(text), at };
    const total =
      chunks.reduce((sum, c, i) => sum + jsonBytes(c) + (SYNC_PREFIX + i).length, 0) +
      JSON.stringify(meta).length +
      SYNC_META.length;
    if (total > SYNC_TOTAL_BYTES) {
      console.warn(`[Watchroll] preferências grandes demais para sincronizar (${total} bytes); ficam só neste aparelho.`);
      return false;
    }
    try {
      const old = ((await area.get(SYNC_META)) || {})[SYNC_META];
      const items = { [SYNC_META]: meta };
      chunks.forEach((c, i) => (items[SYNC_PREFIX + i] = c));
      await area.set(items);
      const stale = [];
      for (let i = chunks.length; old && i < old.n; i++) stale.push(SYNC_PREFIX + i);
      if (stale.length) await area.remove(stale);
      syncedText = text;
      await b.storage.local.set({ [SYNCED_AT_KEY]: at });
      return true;
    } catch (err) {
      // Sem conta/sincronização, cota, limite de gravações…: fica só no local.
      console.warn("[Watchroll] não deu para sincronizar as preferências:", err);
      return false;
    }
  }

  // Primeira vez neste aparelho: soma os modos por série e as ocultas dos dois lados
  // (o sync vence quando os dois têm a mesma série).
  const mergeFirst = (local, remote) => ({
    ...local,
    ...remote,
    seriesModes: { ...(local.seriesModes || {}), ...(remote.seriesModes || {}) },
    hidden: { ...(local.hidden || {}), ...(remote.hidden || {}) },
  });

  /** Lê as preferências guardadas (local + sync), sem os valores padrão. */
  async function loadStored(b = browser) {
    const local = (await b.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
    const remote = await readSync(b);
    // Chegando de outro aparelho: usa o local por enquanto, sem gravar por cima.
    if (remote && remote.incomplete) return local;
    if (!remote) {
      // Nada (completo) no sync: este aparelho é a fonte; leva para lá.
      if (syncArea(b) && Object.keys(local).length) {
        const at = (await b.storage.local.get(SETTINGS_AT_KEY))[SETTINGS_AT_KEY] || Date.now();
        await pushSync(local, at, b);
      }
      return local;
    }
    syncedText = remote.text;
    const localAt = Number((await b.storage.local.get(SETTINGS_AT_KEY))[SETTINGS_AT_KEY]) || 0;
    const syncedAt = Number((await b.storage.local.get(SYNCED_AT_KEY))[SYNCED_AT_KEY]) || 0;

    let chosen;
    let push = false;
    if (!syncedAt && Object.keys(local).length) {
      chosen = mergeFirst(local, remote.data);
      push = true;
    } else if (localAt > remote.at) {
      chosen = local; // mudou aqui depois da última sincronização (ex.: sem rede)
      push = true;
    } else {
      chosen = { ...localPart(local), ...remote.data };
    }

    if (push) {
      const at = Date.now();
      await b.storage.local.set({ [SETTINGS_KEY]: chosen, [SETTINGS_AT_KEY]: at });
      await pushSync(chosen, at, b);
    } else if (JSON.stringify(syncedPart(local)) !== remote.text || syncedAt !== remote.at) {
      // Veio de outro aparelho: atualiza a cópia local (o resto reage a ela).
      await b.storage.local.set({ [SETTINGS_KEY]: chosen, [SETTINGS_AT_KEY]: remote.at, [SYNCED_AT_KEY]: remote.at });
    }
    return chosen;
  }

  async function loadSettings(b = browser) {
    const saved = await loadStored(b);
    const ui = saved.uiLang || DEFAULT_SETTINGS.uiLang;
    const media = CRI18n.mediaLocale ? CRI18n.mediaLocale(ui) : "en-US";
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      dubLang: saved.dubLang || media,
      subLang: saved.subLang || media,
      seriesModes: { ...(saved.seriesModes || {}) },
      hidden: { ...(saved.hidden || {}) },
      sources: Array.isArray(saved.sources) && saved.sources.length ? [...saved.sources] : [...DEFAULT_SETTINGS.sources],
      listNames: { ...(saved.listNames || {}) },
    };
  }

  async function saveSettings(settings, b = browser) {
    const at = Date.now();
    await b.storage.local.set({ [SETTINGS_KEY]: settings, [SETTINGS_AT_KEY]: at });
    await pushSync(settings, at, b);
  }

  // Mudança no storage.sync vinda de outro aparelho?
  const isSyncChange = (changes, area) =>
    area === "sync" && Object.keys(changes || {}).some((k) => k.startsWith(SYNC_PREFIX));

  function autoCheckMinutes(settings) {
    const raw = settings ? settings.autoCheckMinutes : undefined;
    if (raw === undefined || raw === null || String(raw).trim() === "") return AUTO_CHECK.default;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 0) return AUTO_CHECK.default;
    if (n === 0) return 0;
    return Math.min(AUTO_CHECK.max, Math.max(AUTO_CHECK.min, n));
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
  // Filtros por categoria e por modo de áudio da série (legendado/dublado/qualquer).
  const AUDIO_FILTERS = ["sub", "dub", "auto"];
  const activeAudioFilter = (settings) =>
    AUDIO_FILTERS.includes(settings && settings.audioFilter) ? settings.audioFilter : "";
  // Várias categorias escolhidas: basta a série ter uma delas.
  const hasGenre = (r, keys) => {
    const list = Array.isArray(keys) ? keys : keys ? [keys] : [];
    return !list.length || (Array.isArray(r.genres) && list.some((k) => r.genres.includes(k)));
  };
  const hasAudio = (r, mode) => !mode || r.mode === mode;
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
    seasons: "sortSeasonsCount",
    episodes: "sortEpisodesTotal",
  };
  // Ordenações que fazem sentido em cada aba (a primeira é a padrão).
  const TAB_SORTS = {
    toWatch: ["released", "watched", "count", "title"],
    waitDub: ["waiting", "watched", "title"],
    waitSub: ["waiting", "watched", "title"],
    upToDate: ["watched", "next", "title"],
    never: ["season", "title", "seasons", "episodes"],
    errors: ["title"],
    hidden: ["title", "watched"],
  };
  const SEASON_RANK = { winter: 0, spring: 1, summer: 2, fall: 3 };
  const launchRank = (r) => (r.launch ? r.launch.year * 10 + (SEASON_RANK[r.launch.season] ?? 0) : -1);
  const waitingCount = (r) => (r.waitingDub || 0) + (r.waitingSub || 0);
  const nextAt = (r) => (r.next && r.next.at) || Infinity;
  // Temporadas/episódios da série; sem a informação (filme, cache antigo) vai para o fim.
  const statOf = (r, k) => (r.stats && typeof r.stats[k] === "number" ? r.stats[k] : -1);

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
      seasons: (a, b) => statOf(b, "seasons") - statOf(a, "seasons") || byTitle(a, b),
      episodes: (a, b) => statOf(b, "episodes") - statOf(a, "episodes") || byTitle(a, b),
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
    if (!b.action) return;
    await b.action.setBadgeText({ text: badgeText(episodes) });
    // Cores do contador: no Firefox para Android podem não existir.
    try {
      if (b.action.setBadgeBackgroundColor) await b.action.setBadgeBackgroundColor({ color: "#ff640a" });
      if (b.action.setBadgeTextColor) await b.action.setBadgeTextColor({ color: "#000000" });
    } catch (_) {
      // sem cores: o número continua aparecendo
    }
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
    // Também conta como saído quando a série já aponta um lançamento posterior
    // (o episódio saiu com outro id, como nas previsões pelo ritmo semanal, ou
    // foi remarcado).
    return !r || (r.pending || []).some((p) => p.id === e.id) || !!(r.next && r.next.at > e.at);
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
        console.warn("[Watchroll] verificação automática falhou:", err);
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
    AUTO_CHECK,
    DEFAULT_SETTINGS,
    loadSettings,
    saveSettings,
    syncedPart,
    isSyncChange,
    chunkText,
    SYNC_META,
    SYNC_PREFIX,
    autoCheckMinutes,
    pendingItems,
    summarize,
    matchesSearch,
    activeListFilter,
    inList,
    AUDIO_FILTERS,
    activeAudioFilter,
    hasGenre,
    hasAudio,
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
