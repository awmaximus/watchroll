# Watchroll for Chrome and Chromium-based browsers

Build for Google Chrome, Microsoft Edge, Brave, Opera, Vivaldi and other Chromium browsers
(Chrome 120 or later). The extension code is the same as the Firefox one, in `../common/`;
this folder only has what is specific to Chrome:

```
manifest.json       MV3 manifest for Chrome (service worker, PNG toolbar icons, short description)
service-worker.js   background: loads the shared scripts from common/src/ with importScripts()
package.json        npm scripts and the Chrome version
build-chrome.sh     tests, manifest checks, package in chrome/dist/
store/listing.md    Chrome Web Store texts and the answers the store asks for
dist/               generated packages (not in git)
```

## How the shared code runs in Chrome

- `common/src/compat.js` is loaded first everywhere. In Firefox it does nothing. In Chrome it
  makes `browser` point to `chrome` (promise-based in MV3) and lets `runtime.onMessage`
  listeners answer with a Promise, as in Firefox.
- The background runs as a service worker (`service-worker.js`) instead of Firefox's
  background scripts. Everything it keeps between checks is already in `storage`, so being
  stopped and restarted by Chrome is fine.
- Without the `tabs` permission Chrome ignores the URL filter of `tabs.query`, so the code
  checks the URL itself before reusing the extension's tab.
- The store description must be 132 characters or less, so the Chrome manifest uses
  `extDescriptionShort` (27 languages) instead of Firefox's longer `extDescription`.
- Firefox-only features fall back silently: there is no "share search terms" permission (the
  AniList option just turns on), and the "open in the Crunchyroll app" option (Firefox for
  Android) never shows.

## Build

```sh
chrome/build-chrome.sh                 # tests + manifest checks + chrome/dist/watchroll-chrome-<version>.zip
chrome/build-chrome.sh --skip-tests    # skip tests
chrome/build-chrome.sh --check         # also load it in a test Chromium and fail on errors
```

`--check` needs Playwright (`npm i -g playwright && npx playwright install chromium`; set
`NODE_PATH="$(npm root -g)"` if it is installed globally). It starts the service worker, opens
the extension page and fails if either throws an error. Errors the extension handles itself
(no Crunchyroll session or network in the test browser) are ignored.

Keep `version` the same in `manifest.json` and `package.json`. The Chrome Web Store has its
own version history, separate from addons.mozilla.org; using the same number as the Firefox
release keeps things simple. Chrome accepts only numbers (`1.2.3`, up to four parts).

## Install for testing

1. Run `chrome/build-chrome.sh` and unzip `chrome/dist/watchroll-chrome-<version>.zip` into a
   folder.
2. Open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**.
3. **Load unpacked** and pick that folder.

## Publish

1. Create a developer account at <https://chrome.google.com/webstore/devconsole> (one-time fee).
2. **New item** → upload `chrome/dist/watchroll-chrome-<version>.zip`.
3. Fill the listing and the privacy tab with the texts in [store/listing.md](store/listing.md).
   Screenshots: the 1280×800 images in `../firefox/store/screenshots/` work as they are.
4. For a new version: bump `version` in `manifest.json` and `package.json`, build and upload
   the new `.zip` in the same item.

Edge has its own store (Microsoft Partner Center) and accepts the same `.zip`.
