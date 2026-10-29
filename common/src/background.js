// Segundo plano:
//  - o botão na barra abre (ou foca) a página da extensão;
//  - guarda, só em memória de sessão, o último token que o site da Crunchyroll usou;
//  - verificação automática periódica: atualiza o número no ícone e notifica
//    episódios novos. Nunca abre abas sozinho;
//  - verificação extra logo depois do horário de lançamento de cada próximo
//    episódio conhecido, para o alerta chegar na hora.

/* global browser, CRApi, CRAnalyzer, CRChecker, CRI18n */
const PAGE = browser.runtime.getURL("dashboard/dashboard.html");
const ALARM = "crnovos-verificacao";
const RELEASE_ALARM = "crnovos-lancamento"; // verificação extra logo após um lançamento

// No Firefox para Android não existe a API de janelas (browser.windows): lá só a
// aba é ativada.
async function openPage() {
  let tab = null;
  try {
    // No Chrome, sem a permissão "tabs" o filtro por url é ignorado e a consulta
    // devolve todas as abas: por isso a conferência do endereço aqui.
    tab = (await browser.tabs.query({ url: PAGE })).find((t) => t.url && t.url.startsWith(PAGE)) || null;
  } catch (_) {
    tab = null;
  }
  if (tab) {
    await browser.tabs.update(tab.id, { active: true });
    if (browser.windows && tab.windowId != null) {
      try {
        await browser.windows.update(tab.windowId, { focused: true });
      } catch (_) {
        // a aba já está ativa
      }
    }
  } else {
    await browser.tabs.create({ url: PAGE });
  }
}

browser.action.onClicked.addListener(openPage);

if (browser.notifications) {
  browser.notifications.onClicked.addListener((id) => {
    if (id === CRChecker.NOTIFICATION_ID) return openPage();
  });
}

function jwtProfile(token) {
  try {
    const p = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof p.profile_id === "string" ? p.profile_id : "";
  } catch (_) {
    return "";
  }
}

function looksLikeJwt(token) {
  if (token.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]*$/.test(token)) return false;
  try {
    const p = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return !!p && typeof p === "object";
  } catch (_) {
    return false;
  }
}

function jwtExp(token) {
  try {
    const p = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (p.exp) return p.exp * 1000;
  } catch (_) {}
  return Date.now() + 4 * 60 * 1000;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "crnovos-token" && typeof msg.token === "string") {
    // Só aceita vindo de uma aba normal (não privativa) da Crunchyroll, e só um
    // JWT legível: outro script da página poderia disparar o mesmo evento.
    if (!sender.url || !sender.url.startsWith("https://www.crunchyroll.com/")) return;
    if (sender.tab && sender.tab.incognito) return;
    if (!looksLikeJwt(msg.token)) return;
    const profile = jwtProfile(msg.token);
    return Promise.all([
      browser.storage.session.set({ crToken: { token: msg.token, exp: jwtExp(msg.token), at: Date.now() } }),
      // Perfil aberto no site (persistente): serve para avisar se a extensão acabar
      // usando uma sessão de outro perfil.
      profile ? browser.storage.local.set({ crSiteProfile: profile }) : null,
    ]);
  }
});

// ---------- verificação automática ----------
async function schedule() {
  const minutes = CRChecker.autoCheckMinutes(await CRChecker.loadSettings());
  await browser.alarms.clear(ALARM);
  if (minutes > 0) {
    await browser.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: minutes });
  }
}

function check() {
  CRApi.setAllowOpenTab(false);
  return CRChecker.checkNow({ analyzer: CRAnalyzer, api: CRApi });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM || alarm.name === RELEASE_ALARM) check();
});

// Reagenda a verificação extra a partir do último resultado (da página ou do
// segundo plano): logo depois do próximo lançamento conhecido.
async function scheduleRelease(results) {
  const settings = await CRChecker.loadSettings();
  if (!results) {
    const last = await CRChecker.lastResults();
    results = last ? last.results : [];
  }
  const when = await CRChecker.nextReleaseCheck(results || [], settings);
  await browser.alarms.clear(RELEASE_ALARM);
  if (when) await browser.alarms.create(RELEASE_ALARM, { when });
}

browser.runtime.onInstalled.addListener(schedule);
browser.runtime.onStartup.addListener(async () => {
  await schedule();
  await scheduleRelease();
  await CRI18n.init((await CRChecker.loadSettings()).uiLang || "auto");
  // Restaura o número no ícone com o último resultado conhecido.
  const last = await CRChecker.lastResults();
  if (last) await CRChecker.updateBadge(CRChecker.visibleResults(last.results, await CRChecker.loadSettings()));
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[CRChecker.LAST_KEY]) {
    const v = changes[CRChecker.LAST_KEY].newValue;
    scheduleRelease(v ? v.results : []);
  }
  if (!changes[CRChecker.SETTINGS_KEY]) return;
  const before = changes[CRChecker.SETTINGS_KEY].oldValue || {};
  const after = changes[CRChecker.SETTINGS_KEY].newValue || {};
  if (CRChecker.autoCheckMinutes(before) !== CRChecker.autoCheckMinutes(after)) schedule();
  if (CRChecker.releaseAlertsOn(before) !== CRChecker.releaseAlertsOn(after)) scheduleRelease();
});
