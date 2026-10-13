// Partes compartilhadas entre a página e o segundo plano:
//  - preferências (valores padrão e leitura);
//  - contagem de episódios para o ícone;
//  - "o que é novo desde a última vez" e a notificação correspondente;
//  - a verificação completa usada pelo alarme.

/* global browser */
var CRChecker = (() => {
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
    autoCheckMinutes: 60,
    notify: true,
    showExtras: true,
    seriesModes: {},
  };

  async function loadSettings(b = browser) {
    const saved = (await b.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
    return { ...DEFAULT_SETTINGS, ...saved, seriesModes: { ...(saved.seriesModes || {}) } };
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
        ? `Novos episódios: ${episodes} em ${series} série${series > 1 ? "s" : ""}`
        : "Novos episódios da Crunchyroll: tudo em dia",
    });
  }

  function notificationText(fresh) {
    const bySeries = new Map();
    for (const i of fresh) {
      const list = bySeries.get(i.series.seriesId) || { title: i.series.title, eps: [] };
      list.eps.push(`T${i.ep.season ?? "?"} E${i.ep.number || "?"}`);
      bySeries.set(i.series.seriesId, list);
    }
    const lines = [...bySeries.values()].map((s) => `${s.title}: ${s.eps.join(", ")}`);
    const shown = lines.slice(0, 4);
    if (lines.length > shown.length) shown.push(`+ ${lines.length - shown.length} série(s)`);
    return {
      title: fresh.length === 1 ? "1 episódio novo" : `${fresh.length} episódios novos`,
      message: shown.join("\n"),
    };
  }

  /**
   * Guarda o resultado, atualiza o ícone e devolve os episódios que não tinham
   * aparecido antes. Na primeira vez (nada guardado), só registra: não há "novo".
   * Com notify, mostra uma notificação dos novos (se a preferência permitir).
   */
  async function record(results, { notify = false, settings = DEFAULT_SETTINGS, scope = "", b = browser } = {}) {
    const items = pendingItems(results);
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
    await updateBadge(results, b);
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

  async function lastResults(b = browser) {
    return (await b.storage.local.get(LAST_KEY))[LAST_KEY] || null;
  }

  // Verificação completa usada pelo alarme do segundo plano.
  let running = null;
  function checkNow({ analyzer, api, b = browser }) {
    if (running) return running;
    running = (async () => {
      const settings = await loadSettings(b);
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
    NOTIFICATION_ID,
    AUTO_CHECK_OPTIONS,
    DEFAULT_SETTINGS,
    loadSettings,
    saveSettings,
    autoCheckMinutes,
    pendingItems,
    summarize,
    badgeText,
    updateBadge,
    notificationText,
    record,
    lastResults,
    checkNow,
  };
})();
