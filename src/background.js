// Background mínimo:
//  - o botão na barra abre (ou foca) a página da extensão;
//  - guarda, só em memória de sessão, o último token que o site da Crunchyroll usou.

/* global browser */
const PAGE = browser.runtime.getURL("dashboard/dashboard.html");

browser.action.onClicked.addListener(async () => {
  const [tab] = await browser.tabs.query({ url: PAGE });
  if (tab) {
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: PAGE });
  }
});

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
    return browser.storage.session.set({
      crToken: { token: msg.token, exp: jwtExp(msg.token), at: Date.now() },
    });
  }
});
