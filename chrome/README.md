# Chrome and Chromium-based browsers (planned)

This folder will hold what is specific to Google Chrome and Chromium-based browsers (Edge,
Brave, Opera, Vivaldi…), next to `../firefox/` for Firefox. The extension code itself lives in
`../common/` and is shared by every browser.

What a Chrome build still needs (not done yet):

- `manifest.json` for Chrome (MV3): `background.service_worker` instead of `background.scripts`
  (a small `background.js` here that `importScripts()` the files from `common/src/`), no
  `browser_specific_settings`, `"incognito": "not_allowed"` kept, the same permissions and
  content scripts (`world: "MAIN"` is supported).
- The `browser.*` API: the code in `common/` uses Firefox's promise-based `browser` namespace.
  Chrome exposes `chrome.*` (promise-based in MV3); a tiny shim (`globalThis.browser ??= chrome`)
  loaded first is enough for the APIs Watchroll uses. `browser.storage.session`,
  `scripting`, `alarms` and `notifications` exist in Chrome MV3.
- `runtime.getPlatformInfo().os` is never `"android"` in Chrome, so the "open in the
  Crunchyroll app" option stays hidden there.
- `build-chrome.sh` and `package.json` in this folder, like `../firefox/build-firefox.sh`: copy
  `common/` plus this folder's `manifest.json` into a clean folder and zip it for the Chrome
  Web Store (output in `chrome/dist/`, already ignored by git).
- The tests in `../common/tests/` already cover the shared code; a Chrome build only needs
  them to pass.
- Chrome Web Store listing text, screenshots (1280×800) and icons in `chrome/store/`.
