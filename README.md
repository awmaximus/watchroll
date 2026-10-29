# Watchroll – New Episodes for Crunchyroll

Watchroll is a browser extension that tracks the anime you follow on Crunchyroll. One page
lists, for every series in your **Watchlist** and the **Crunchylists** you choose, the episodes
released after the last one you watched, what's coming this week, and when the next episode
drops. It tells you when new ones come out.

It runs in **Firefox** (desktop and Android) and in **Chrome** and Chromium-based browsers
(Edge, Brave, Opera, Vivaldi), from the same code.

- Firefox: [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/b49819c4edbb4eac9ebc/)
- Chrome: Chrome Web Store (under review); meanwhile, see [Installation](#installation)
- Source code and issues: <https://github.com/awmaximus/watchroll>

Unofficial. Not affiliated with or endorsed by Crunchyroll. It uses Crunchyroll's undocumented
API with the session you already have in your browser, only reads data from your own account
and never changes anything on Crunchyroll.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Using Watchroll](#using-watchroll)
- [Settings](#settings)
- [How episodes are determined](#how-episodes-are-determined)
- [Authentication and privacy](#authentication-and-privacy)
- [Development](#development)
- [Contributing](#contributing) · [License](#license)

## Features

- **Unwatched episodes per series**, computed from your real playback progress, not from
  Crunchyroll's "Up Next" (which is sometimes wrong).
- **Subbed or dubbed, per series.** A dubbed series only shows an episode once the dub in your
  language is out; a subbed one only once subtitles in your language are available.
- **New-episode alerts:** a notification and a counter on the toolbar icon, with an extra check
  right after each known release time.
- **Week** calendar of the next 7 days of releases, with a countdown for the next few hours.
- **Watchlist + Crunchylists**, with a label showing which list each series came from.
- **Tabs** for every state: to watch, dub pending, subtitles pending, caught up, week, to start,
  errors and hidden, each with its own sorting.
- **Filter bar** on every tab: title search, list, categories (several at once) and sub/dub.
- **Crunchyroll rating** (★ 4.9) and **categories** (Action, Fantasy, Romance…) on every series.
- **Advanced Search** over the whole catalog or only your lists, with dub, category, minimum
  seasons, age rating, year and season filters, and optional Japanese/romaji title lookup
  through AniList.
- **Hide or snooze** a series, **compact mode**, **settings export/import**.
- **Settings synced** across your computers through the browser's own sync.
- **27 interface languages**, including right-to-left Arabic and Urdu.

## Installation

You need a Crunchyroll account signed in in the same browser.

| Browser | How |
|---|---|
| Firefox 142+ (desktop and Android) | Install from [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/b49819c4edbb4eac9ebc/). |
| Chrome 120+, Edge, Brave, Opera, Vivaldi | From the Chrome Web Store once it is published. Until then, load it unpacked (below). |

**Chrome, unpacked:** download `watchroll-chrome-<version>.zip` from the
[latest release](https://github.com/awmaximus/watchroll/releases) (or build it with
`chrome/build-chrome.sh`) and unzip it into a folder you will keep. Open `chrome://extensions`
(`edge://extensions`, `brave://extensions`…), turn on **Developer mode**, click **Load unpacked**
and pick that folder. To update, unzip the new version over the same folder and click the
reload button on the Watchroll card.

**Firefox, for testing:** build with `firefox/build-firefox.sh`, open
`about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick
`firefox/dist/watchroll-<version>.zip`. It is removed when Firefox closes. The unsigned `.zip`
can be installed permanently only in Firefox Developer Edition or Nightly with
`xpinstall.signatures.required` set to `false`.

## Using Watchroll

Click the Watchroll icon in the toolbar to open its page (on Firefox for Android: menu →
**Extensions** → **Watchroll**). The header links open Crunchyroll's home page, your Watchlist
and each selected Crunchylist. Below the name you see the episode count and when the results
were last updated. The last known result shows up immediately and is refreshed in the
background; **Refresh** forces a full check.

### Tabs

Tab names are short so the bar never scrolls sideways; on narrow screens it wraps. Search is the
magnifier icon and Settings the gear. Empty tabs are hidden, except To watch, Caught up, Week,
To start, Search and Settings. The selected tab is remembered, and ← / → switch tabs.

| Tab | Shows |
|---|---|
| To watch | Episodes released after the last one you watched, as cards (or rows in compact mode, with a ▶ button for the next episode). Half-watched episodes show a progress bar. |
| Dub pending | Dubbed-mode series with episodes that are out but not dubbed in your language yet. If the current season has no episode at all in your language, the note says so (the dub may never come) and **Watch subbed** switches the series to subbed mode. |
| Subs pending | Subbed-mode series with episodes released without subtitles in your language yet. If no released episode of the current season has them, the note says so and **Watch without subtitles** switches the series to *Any audio*. |
| Caught up | Series with nothing pending. |
| Week | The next episode of each series releasing in the next 7 days, grouped by day, with the time. Crunchyroll only lists an episode once it is out, so simulcast dates are estimated from the weekly pace (7 days after the last episode, same time) and marked with `~`; a date Crunchyroll publishes takes precedence. No estimate when episodes aren't weekly or the expected one is already late. |
| To start | Series you never watched, with their number of seasons and episodes (regular seasons only). Grouped by release season (Fall 2026, Summer 2026…) by default; **Group** turns that off. |
| Errors | Series whose check failed, with the error. |
| Search | [Advanced Search](#advanced-search). |
| Hidden | Series you hid. **Show** brings one back. |

### Filter bar

Above the list tabs, on one line on wide screens. A filter in use is outlined in orange, and
**Clear filters** resets all of them.

- **Search** filters by title, ignoring accents and case. If the current tab has no match, the
  first tab with one is shown.
- **List** (with more than one list selected) filters by Watchlist or Crunchylist.
- **Category**: tick one or more; a series shows up if it has any of them. Only categories your
  series have are listed, with counts. Names Crunchyroll sends in mixed languages ("Fantasia"
  and "Fantasy") are merged and shown in the interface language.
- **Audio**: Subbed, Dubbed or Any audio (each series' mode, or the default).
- **Sort**, saved per tab:

| Tab | Sort options |
|---|---|
| To watch | Most recent release, Most recently watched, Most episodes, Title |
| Dub pending, Subs pending | Most episodes waiting, Most recently watched, Title |
| Caught up | Most recently watched, Next release, Title |
| To start | Release season, Title, Most seasons, Most episodes in total |
| Hidden | Title, Most recently watched |

### On each series

- **Rating:** the Crunchyroll average (★ 4.9); hover for the number of ratings.
- **Dub indicator:** a microphone with your dub language. Green: the latest season has that
  dub. Yellow, dashed: only earlier seasons have it. Grey, crossed out: no dub.
- **List labels:** with more than one list selected, the list(s) the series came from.
- **Next release:** for example "Next: S2 E13 in 3 days (Thu, 10/16)". In the last 6 hours it
  becomes a highlighted countdown updated every minute. In dubbed mode, the date of the dub.
- **Mode selector:** default, subbed, dubbed or any audio, for this series only.
- **⋯ menu:** hide until a new episode is out, hide for 1 week, always hide, or export
  [diagnostics](#diagnostics).
- **Specials and recaps** (13.5, SP, OVA, recap titles, special seasons) are tagged and not
  counted on the card, the icon or in notifications.

### New-episode alerts

- The background checks at the interval set in Settings (default: every hour) and shows the
  number of new episodes on the toolbar icon.
- It also checks **3 minutes after the next known release time** of each series. If an episode
  that should be out hasn't appeared yet, it checks again every 10 minutes for up to 3 hours.
- A new episode you haven't seen on the page triggers a **notification**; clicking it opens the
  page. If the page is open, it updates by itself.
- The first check only records what already exists. Episodes already shown, specials, recaps
  and hidden series never trigger a notification.
- Alerts need both **Notify me when a new episode is out** and **Check automatically** on.
- The background never opens tabs. If direct API access is blocked and no crunchyroll.com tab
  is open, that check is skipped.

### Advanced Search

- **Text** uses Crunchyroll's search, which understands titles in the site's languages but not
  Japanese script.
- **Japanese and romaji names (optional):** with *Also search Japanese and romaji names* on, the
  search text is also sent to [AniList](https://anilist.co), which returns the Crunchyroll
  link: "薬屋のひとりごと" or "Kusuriya no Hitorigoto" finds *The Apothecary Diaries*. Off by
  default; in Firefox, turning it on asks permission to share search terms.
- **No text:** with a season, lists what Crunchyroll tags for that season. Otherwise the whole
  catalog (about 1,900 titles) is downloaded in under a second, kept for 6 hours and filtered
  locally, because Crunchyroll's ranking and its server-side "dubbed" filter are unreliable.
- **Search in:** whole catalog or only your lists.
- **Filters:** dub in your dub language, age rating (the Brazilian ratings Crunchyroll provides:
  L, 10, 12, 14, 16, 18), categories (several at once), year, release season and **Min.
  seasons** (2 to 6; Crunchyroll's season count can include dubbed copies, so it may be higher
  than the real number; movies are left out).
- **Sort:** Crunchyroll default, newest release or title. Results load 60 at a time, with a
  loading indicator.

### Firefox for Android

The same Firefox extension runs on Android. Differences:

- **Links open in the Crunchyroll app** (`intent://` links for `com.crunchyroll.crunchyroid`);
  without the app, Firefox opens the normal page. The setting **Open Crunchyroll links in the
  Crunchyroll app** (shown only on Android, on by default) turns this off.
- The counter appears in Firefox's menu instead of a toolbar, and its colors may be ignored.
- The filter bar and the tabs wrap to fit a phone screen.

### Chrome and Chromium-based browsers

Same features as on Firefox desktop. The only differences are under the hood (service worker
background, no "share search terms" permission for AniList); see
[chrome/README.md](chrome/README.md).

## Settings

Changes are saved immediately and synced to your other computers (see
[Settings sync](#settings-sync)).

| Setting | What it does |
|---|---|
| Lists to check | Your Watchlist and Crunchylists (names read from Crunchyroll). At least one stays selected. A series in several lists is checked once. A deleted Crunchylist shows as "List not found". |
| Extension language | One of 27 languages, or *Automatic* (the browser's language; English when it isn't translated). |
| Language you watch dubbed in | Dub language for dubbed-mode series and the dub indicator; any of Crunchyroll's 24 audio languages. Starts as the interface language. |
| Subtitle language | Subtitles required before a subbed episode is announced. |
| Default mode for series | Subbed, dubbed or any audio, for series without their own mode. |
| Language for titles and links | Language of series and episode names and of links. *Automatic* follows the extension language; otherwise one of the 16 languages the site supports. |
| Check automatically | Interval in minutes, 5 to 1440 (default 60); 0 turns it off. |
| Notify me when a new episode is out | Notifications (on by default). |
| Open Crunchyroll links in the Crunchyroll app | Firefox for Android only (on by default). |
| Show specials and recaps | Shows them, tagged and uncounted (on by default). |
| Show skipped episodes | Unwatched episodes before the last one you watched, tagged and uncounted (off by default). |
| Show "To watch" in compact mode | Rows instead of cards (off by default). |
| Also search Japanese and romaji names | Sends Advanced Search text to AniList (off by default). |
| Count as started after (seconds) | Ignores playback records shorter than this (default 60, 0–600); Crunchyroll records a few seconds just from opening an episode page. |
| Series checked at the same time | Parallel requests (default 4, 1–32). Lower it if you get HTTP 429 errors. |
| Batch size | Episodes per progress request and items per list/history page (default 100, 10–300). Lower it if checks start failing. |
| Settings backup | **Export** saves your settings to a JSON file; **Import** restores them. No login, token or history is included. |

### Settings sync

Settings are also saved in the browser's `storage.sync`, which the browser carries to your other
computers signed in to the same account (Firefox Sync, or Chrome sync with your Google account).
Sync is always on; without an account, or if sync fails, everything keeps working with the local
copy. Firefox and Chrome don't sync with each other.

- **Synced:** languages, lists to check, default and per-series modes, hidden series, sorting
  and the other options.
- **Not synced:** the open tab, the filters, Crunchylist names read from Crunchyroll, the last
  result, the cache and the session token.
- The browser allows about 100 KB in total and 8 KB per item, so the settings JSON is split into
  pieces (`crnovos:sync:0`, `:1`…) with a `crnovos:sync:meta` item holding the count, length and
  a checksum. Pieces still arriving from another computer don't match the checksum and are
  ignored until complete.
- The newest change wins. The first time a computer that already had settings finds some in
  sync, per-series modes and hidden series from both sides are merged.
- A change from another computer is applied by the background and shows up on an open page
  right away.

## How episodes are determined

For each series Watchroll:

1. reads the seasons and episodes (`/content/v2/cms/…`), newest season first;
2. reads your playback progress (`/content/v2/{account}/playheads`) for **every audio version**
   of each episode;
3. finds the last episode you touched and lists the **available** episodes after it that you
   haven't finished.

Rules:

- **Started:** at least the configured number of seconds played, or marked watched.
- **Watched:** Crunchyroll's `fully_watched`, or more than 90% of the duration, in any audio.
- **Subbed:** the original-audio episode list, requiring subtitles in your subtitle language.
- **Dubbed:** the episode list of your dub language, checking the audio of **each episode**,
  because Crunchyroll fills the dubbed list with the original version until the dub is out.
- **Any audio:** an episode counts as soon as any version is out.
- **Movies** in your lists are checked too; multi-part movies are listed part by part.
- **Not started shortcut:** the watch history (`/content/v2/{account}/watch-history`, up to 10
  pages) is read first. A series goes straight to *To start* only if the history was read to the
  end, it has no activity there and Crunchyroll also flags it as never watched; otherwise the
  full check runs.

Lists come from `/content/v2/discover/{account}/watchlist` and
`/content/v2/{account}/custom-lists/{list}` (Crunchyroll caps a Crunchylist at 100 items).

### Speed and freshness

- The Watchlist, the Crunchylists and the history are read at the same time, with their pages in
  parallel; progress requests from several series are batched.
- Ratings come with the lists (`ratings=true`, as on the site). Titles without one are looked up
  after the check and kept for 24 hours, so the list never waits for them.
- On HTTP 429 Watchroll waits as asked (`Retry-After`, otherwise 1, 2, 4, 8… up to 60 s) and
  retries up to 4 times; the pause applies to all requests in flight.
- Results are reused for 5 minutes. From 5 minutes to 6 hours, a cheap revalidation reuses the
  previous result if nothing changed. After 6 hours, after a scheduled release time or on
  **Refresh**, the check is full.
- Requests skip the browser cache (`cache: "no-store"`) and use the same query parameters as the
  site, so Crunchyroll's CDN returns the copy the site keeps fresh.

## Authentication and privacy

- No password is asked for or stored. Watchroll uses your Crunchyroll session in the browser.
- `common/src/page-hook.js` runs on Crunchyroll pages and only reads the `Bearer` token the site
  itself uses; the token is kept in session memory. Your account ID is read from the token
  (`etp_user_id`).
- Without a recent site token, Watchroll requests one from `/auth/v1/token` with
  `grant_type=etp_rt_cookie`, as the site does on load.
- History is per profile, and the profile comes from the token. Cache, seen episodes and the
  last result are stored per profile. With several profiles, the profile name is shown at the
  top, with a warning if Watchroll ends up using another profile's session.
- The page calls the API directly. If Cloudflare blocks it, requests go through a
  crunchyroll.com tab via `common/src/bridge.js`; if none is open, one is opened in the
  background and closed afterwards (never during background checks).
- The background only accepts a token from a normal (non-private) crunchyroll.com tab, and only
  if it is a readable JWT.
- Watchroll does not run in private windows, so nothing from private browsing is stored.
- Settings (not the token, history or results) go through the browser's own sync, to your
  other computers signed in to the same account.
- Nothing is sent to third parties, except Advanced Search text to AniList when you turn that on.
  See [PRIVACY.md](PRIVACY.md).

## Development

Requires Node 22 or later and no other dependencies (Playwright only for the optional Chrome
`--check`). Build scripts can be run from anywhere.

### Project layout

The code shared by both browsers is in `common/`; each browser folder only has what is specific
to it. Each package is `common/` plus that folder, with everything at the package root (so the
manifests refer to `src/`, `dashboard/`…).

```
common/                       shared by all browsers
  _locales/                   interface texts, 27 languages
  dashboard/                  extension page (HTML, CSS, JS)
  icons/                      extension icons
  src/background.js           toolbar button, session token, periodic and release-time checks
  src/checker.js              settings (local + sync), icon counter, new-episode detection, notifications
  src/analyzer.js             "what's left to watch" logic, lists, categories and cache
  src/api.js                  Crunchyroll API calls, authentication and transport
  src/search.js               Advanced Search
  src/i18n.js                 translations and language selection
  src/page-hook.js            reads the token used by the site (world: MAIN)
  src/bridge.js               relays requests through a crunchyroll.com tab
  src/compat.js               Chrome: browser = chrome, promise replies in onMessage (no-op in Firefox)
  tests/                      unit and integration tests with mocked browser and API (not packaged)
firefox/                      Firefox (desktop and Android)
  manifest.json               MV3 manifest for Firefox
  build-firefox.sh            tests, lint, package and signing
  package.json                npm scripts and version
  amo-metadata.json           addons.mozilla.org metadata for releases
  store/screenshots/          addons.mozilla.org screenshots
  dist/                       generated packages (.zip, .xpi), not in git
chrome/                       Chrome and Chromium-based browsers (see chrome/README.md)
  manifest.json               MV3 manifest for Chrome (service worker)
  service-worker.js           background: loads common/src/ with importScripts()
  build-chrome.sh             tests, manifest checks, package (and --check in Chromium)
  package.json                npm scripts and version
  store/                      Chrome Web Store texts, screenshots and promo tile
  dist/                       generated packages, not in git
PRIVACY.md                    privacy policy (both browsers)
.github/workflows/ci.yml      CI and releases
```

### Tests

```sh
npm --prefix firefox test     # or: cd firefox && npm test (node:test, common/tests/)
```

### Firefox build

```sh
firefox/build-firefox.sh                  # tests + lint + firefox/dist/watchroll-<version>.zip
firefox/build-firefox.sh --skip-tests     # skip tests
firefox/build-firefox.sh --skip-lint      # skip web-ext lint
firefox/build-firefox.sh --sign           # also sign on AMO; the channel comes from the version
firefox/build-firefox.sh --sign --listed  # same, but refuses an odd version
firefox/build-firefox.sh --run            # package and open a test Firefox
```

The script stops at the first failure. It checks that `firefox/manifest.json` and
`firefox/package.json` have the same version, checks syntax, runs the tests, copies **only**
the manifest and `common/{_locales,src,dashboard,icons}` to a temporary folder, scans it for
credentials, runs `web-ext lint` with warnings as errors and zips it.

**Odd versions are test builds, even versions are releases.** With `--sign`, the last number
picks the AMO channel:

| Version | Channel | Result |
|---|---|---|
| odd (1.2.3) | `unlisted` | Signed right away; the `.xpi` goes to `firefox/dist/` for local testing. |
| even (1.2.4) | `listed` | Submitted to the public listing with `firefox/amo-metadata.json`. |

Flow: bump to the next odd version, `--sign`, install the `.xpi` and test; if all is well, bump
to the next even version, commit, tag and `--sign`. AMO never accepts the same version twice.

Signing needs the JWT issuer and secret from
<https://addons.mozilla.org/developers/addon/api/key/>, in `firefox/.amo-credentials` (kept out
of git, `chmod 600`) or in environment variables (`API_KEY`/`API_SECRET`,
`AMO_JWT_ISSUER`/`AMO_JWT_SECRET` or `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET`):

```sh
cat > firefox/.amo-credentials <<'CRED'
API_KEY="user:12345:67"
API_SECRET="..."
CRED
chmod 600 firefox/.amo-credentials
```

The add-on ID (`crunchyroll-novos-eps@awmaximus.github.io`) predates the rename and must stay as
it is: changing it would make Firefox and AMO treat Watchroll as a different extension.

AMO has no keyword field, so the search terms (anime, episode tracker, new episodes, Watchlist,
Crunchylists, sub/dub, release calendar, simulcast, notifications) are in the localized names
and summaries in `common/_locales/` and in the descriptions in `firefox/amo-metadata.json`.

### Chrome build

```sh
chrome/build-chrome.sh                 # tests + manifest checks + chrome/dist/watchroll-chrome-<version>.zip
chrome/build-chrome.sh --skip-tests
chrome/build-chrome.sh --check         # also loads it in a test Chromium and fails on errors
```

Publishing to the Chrome Web Store (and Edge Add-ons, which takes the same `.zip`) is described
in [chrome/README.md](chrome/README.md); the store texts are in
[chrome/store/listing.md](chrome/store/listing.md).

### Versions

Keep the same `version` in `firefox/manifest.json`, `firefox/package.json`,
`chrome/manifest.json` and `chrome/package.json` (current: 1.2.3). Publish only even versions to
the Chrome Web Store, like the AMO listing.

### Continuous integration and releases

`.github/workflows/ci.yml` runs on every push and pull request with Node 22: the Firefox build
(tests, lint, package) and the Chrome build, keeping both `.zip` files as a build artifact.

Pushing a version tag publishes a GitHub release with both `.zip` files attached:

```sh
git commit -am "Watchroll 1.2.4"
git tag v1.2.4
git push && git push origin v1.2.4
```

The release job checks that the tag matches both manifests, then creates the release with notes
generated from the commits (or replaces the files if it already exists). For an older tag, use
**Actions → CI → Run workflow** with the tag name.

### Translations

Each language is `common/_locales/<code>/messages.json` (`en_US`, `pt_BR`, `es_419`, `zh_TW`…).
Keys ending in `_one`/`_other` are singular/plural. Tests check that every file has the same keys
and placeholders. Because `browser.i18n` only follows the browser language, `common/src/i18n.js`
loads the chosen file itself, with English as the fallback. To add a language, copy `en_US`,
translate it, add it to `LANGUAGES` in `common/src/i18n.js` and run the tests.

### Diagnostics

If a series looks wrong, use **⋯ → Export diagnostics** on it. The JSON has everything the check
used (seasons, episodes, that series' playback history and the result), without tokens, cookies,
or account or profile IDs. Prefer it to copying requests from the developer tools, which include
your session. A diagnostics file can become a test with `apiFromDiagnostic()` from
`common/tests/helpers.js`.

Console messages (F12 on the Watchroll page) start with `[Watchroll]`.

| Symptom | Where to look |
|---|---|
| HTTP 401 or 403 | authentication in `common/src/api.js` |
| HTTP 404 or empty data | endpoint URLs in `common/src/api.js` |
| Wrong episodes | `analyzeSeries()` in `common/src/analyzer.js` |

## Contributing

Bug reports and pull requests are welcome at <https://github.com/awmaximus/watchroll/issues>.
Run `firefox/build-firefox.sh` and `chrome/build-chrome.sh` before sending a change. For a series
that shows the wrong episodes, attach its diagnostics file, never a HAR or a request copied from
the developer tools (they contain your session).

## License

MIT. See [LICENSE](LICENSE).
