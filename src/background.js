// Segundo plano:
//  - o botão na barra abre (ou foca) a página da extensão;
//  - guarda, só em memória de sessão, o último token que o site da Crunchyroll usou;
//  - verificação automática periódica: atualiza o número no ícone e notifica
//    episódios novos. Nunca abre abas sozinho.

/* global browser, CRApi, CRAnalyzer, CRChecker, CRI18n */
const PAGE = browser.runtime.getURL("dashboard/dashboard.html");
const ALARM = "crnovos-verificacao";

async function openPage() {
  const [tab] = await browser.tabs.query({ url: PAGE });
  if (tab) {
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
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

function jwtExp(token) {
  try {
    const p = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (p.exp) return p.exp * 1000;
  } catch (_) {}
  return Date.now() + 4 * 60 * 1000;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "crnovos-token" && typeof msg.token === "string") {
    // Só aceita vindo de uma aba da Crunchyroll.
    if (!sender.url || !sender.url.startsWith("https://www.crunchyroll.com/")) return;
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
  if (alarm.name === ALARM) check();
});

browser.runtime.onInstalled.addListener(schedule);
browser.runtime.onStartup.addListener(async () => {
  await schedule();
  await CRI18n.init((await CRChecker.loadSettings()).uiLang || "auto");
  // Restaura o número no ícone com o último resultado conhecido.
  const last = await CRChecker.lastResults();
  if (last) await CRChecker.updateBadge(CRChecker.visibleResults(last.results, await CRChecker.loadSettings()));
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[CRChecker.SETTINGS_KEY]) return;
  const before = changes[CRChecker.SETTINGS_KEY].oldValue || {};
  const after = changes[CRChecker.SETTINGS_KEY].newValue || {};
  if (CRChecker.autoCheckMinutes(before) !== CRChecker.autoCheckMinutes(after)) schedule();
});
