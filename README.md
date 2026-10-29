# Watchroll – New Episodes for Crunchyroll (Firefox)

Watchroll is an anime episode tracker for Firefox. Its own page lists the episodes you haven't
watched yet from the series in your Crunchyroll **Watchlist** and, optionally, your
**Crunchylists**, and it tells you when new ones come out.

Source code and issues: <https://github.com/awmaximus/watchroll>

Unofficial. Not affiliated with or endorsed by Crunchyroll. It uses Crunchyroll's undocumented
API with the session you already have open in Firefox, does not change the Crunchyroll site and
only reads data from your own account.

## Features

- **Unwatched episodes per series**, computed from your real playback progress, not from
  Crunchyroll's "Up Next" state (which is sometimes wrong).
- **Subbed or dubbed, per series.** A dubbed series only shows an episode once the dub in your
  language is out; a subbed one only once subtitles in your language are available.
- **New-episode alerts:** a desktop notification and a counter on the toolbar icon, with an
  extra check right after each known release time.
- **Watchlist + Crunchylists**, with a label showing which list each series came from and a
  list filter on every tab.
- **Tabs** for every state (to watch, dub or subtitles pending, no dub, caught up, not
  started, errors, hidden), each with its own sorting, plus a **Week** calendar of upcoming
  releases.
- **Advanced Search** over the whole Crunchyroll catalog or your lists, with dub, age rating,
  category, year and season filters, and optional Japanese/romaji title lookup through AniList.
- **Crunchyroll rating** (★ 4.9) on every series, in every tab and in Advanced Search.
- **Categories** (Action, Fantasy, Romance…) from Crunchyroll on every series, with a category
  filter and a subbed/dubbed filter on every tab.
- **Hide or snooze** a series, **next release** dates with a countdown when it's close,
  **dub indicator** on every series.
- **Compact mode** (rows instead of cards) and **settings export/import**.
- **27 interface languages**, including right-to-left Arabic and Urdu.

Works in Firefox for desktop and Firefox for Android, version 142 or later, with a Crunchyroll
account signed in in Firefox. See [Firefox for Android](#firefox-for-android).

## Using the extension

Click the Watchroll icon in the toolbar to open its page. The header has links that open
Crunchyroll in a new tab: the home page, your Watchlist and each Crunchylist selected in
Settings (in the language chosen for titles and links). Below the name it shows the episode
count and when the results were last updated (time only for today, date and time otherwise;
hover for the full date), including updates made by the background check. The last known result
appears immediately and is refreshed in the background. **Refresh** forces a full check.

### Tabs

Tab names are short so the tab bar never scrolls sideways; on narrow screens it wraps. *Search*
is the magnifier icon and Settings the gear icon. Empty tabs are hidden, except *To watch*, *Caught up*, *Week*, *To start*,
*Search* and Settings. The selected tab is remembered. ← and → switch tabs from the keyboard.

| Tab | Shows |
|---|---|
| To watch | Episodes released after the last one you watched, as cards (or rows in compact mode, with a ▶ button for the next episode). Half-watched episodes show a progress bar. |
| Dub pending | Dubbed-mode series with episodes that are out but not yet dubbed in your language (the season already has that dub). |
| Subs pending | Subbed-mode series with episodes released without subtitles in your language. |
| No dub | Dubbed-mode series whose current season has no episode at all in your language. **Watch subbed** switches the series to subbed mode. |
| Caught up | Series with nothing pending. |
| Week | The next episode of each series releasing in the next 7 days, grouped by day (Today, Tomorrow, Wednesday, October 21…), with the time. Crunchyroll only lists an episode once it is out, so for simulcasts the date is estimated from the weekly pace (7 days after the last episode, same time) and marked with `~`; a date Crunchyroll does publish takes precedence. No estimate when episodes aren't weekly or the expected one is already late (break or season end). For series you haven't started, only seasons from the current or previous anime season are checked (one extra request each). |
| To start | Series you never watched, with their number of seasons and episodes ("3 seasons · 36 episodes", counting regular seasons only: dub copies and specials are left out). By default grouped by release season (Fall 2026, Summer 2026…), newest first; **Group** turns the groups off. |
| Errors | Series whose check failed, with the error. |
| Search | See [Advanced Search](#advanced-search). |
| Hidden | Series you hid. **Show** brings one back. |
| ⚙ | See [Settings](#settings). |

Above the list tabs, a filter bar that fits on one line on wide screens (it wraps on narrow
ones). A filter in use is outlined in orange, and **Clear filters** resets the search and all
filters at once:

- **Search** filters by title, ignoring accents and case. If the current tab has no match, the
  first tab with one is shown.
- **List** (only with more than one list selected) filters by Watchlist or Crunchylist. Tab
  counts follow the filter; the status line and the icon count all lists.
- **Category** filters by Crunchyroll category. You can tick several: a series shows up if it has
  any of them. It lists only categories your series have, with how many series have each one.
  Crunchyroll sends category names in the title language, sometimes mixed with English
  ("Fantasia" and "Fantasy" in the same list), so known names are merged and shown in the
  extension language; unknown ones are shown as Crunchyroll sends them.
- **Audio** filters by how you watch each series: Subbed, Dubbed or Any audio (the per-series
  setting, or the default).
- **Sort**, saved per tab:

| Tab | Sort options |
|---|---|
| To watch | Most recent release, Most recently watched, Most episodes, Title |
| Dub pending, Subs pending, No dub | Most episodes waiting, Most recently watched, Title |
| Caught up | Most recently watched, Next release, Title |
| To start | Release season, Title, Most seasons, Most episodes in total (inside each group when grouping is on) |
| Hidden | Title, Most recently watched |

### On each series

- **Rating:** the Crunchyroll average (★ 4.9); hovering shows it out of 5 and the number of
  ratings. Series without ratings show nothing.
- **Dub indicator:** a microphone with your dub language. Green: the latest season has that
  dub. Yellow, dashed: only earlier seasons have it. Grey, crossed out: no dub.
- **List labels:** with more than one list selected, the list(s) the series came from.
- **Next release:** for example "Next: S2 E13 in 3 days (Thu, 10/16)". In the last 6 hours
  it becomes a countdown, highlighted on the card and updated every minute ("Next: S2 E13 in
  45 min", "in 3 h (11:05 PM)"). In dubbed mode, the date of the dub. Placeholder dates
  (Crunchyroll uses year 9998 for "no date") are ignored.
- **Mode selector:** default, subbed, dubbed or any audio, for this series only.
- **⋯ menu:** hide until a new episode is out, hide for 1 week, always hide, or export
  diagnostics (see [Diagnostics](#diagnostics)).
- Specials and recaps (episode numbers like 13.5, SP or OVA, no number, recap titles, special
  seasons) are tagged and **not counted** on the card, the icon or in notifications.

### New-episode alerts

- The extension checks in the background at the interval chosen in Settings (default: every
  hour) and shows the number of new episodes on the toolbar icon.
- It also schedules an **extra check 3 minutes after the next known release time** of each
  series. If an episode that should be out has not appeared yet (Crunchyroll sometimes
  releases late), it checks again every 10 minutes for up to 3 hours.
- When an episode you haven't seen on the page appears, a **desktop notification** lists the
  series and episodes; clicking it opens the page.
- If the page is open, it updates by itself and shows how many new episodes arrived.
- The first check only records what already exists. Episodes already shown on the page,
  specials, recaps and hidden series never trigger a notification.
- Alerts need both **Notify me when a new episode is out** and **Check automatically** to be on.
- In the background the extension never opens tabs. If direct API access is blocked and no
  crunchyroll.com tab is open, that check is skipped.

### Advanced Search

- **Text** uses Crunchyroll's search, which understands titles in the site's languages. It does
  not understand Japanese script and only finds romaji that matches a title.
- **Japanese and romaji names (optional):** with *Also search Japanese and romaji names* on,
  the search text is also sent to [AniList](https://anilist.co), which returns the Crunchyroll
  link. For example, "薬屋のひとりごと" or "Kusuriya no Hitorigoto" finds *The Apothecary
  Diaries*. Off by default; turning it on asks Firefox's permission to share search terms.
- **No text:** with a season, lists what Crunchyroll tags for that season. Otherwise the
  extension downloads the whole catalog (about 1,900 titles, under a second) and filters it
  locally. The catalog is kept for 6 hours. (Crunchyroll's popularity ranking and its
  server-side "dubbed" filter are unreliable, so filtering only the first pages would miss
  series.)
- **Search in:** whole catalog or only your lists.
- **Filters:** dub in your dub language (not just "has some dub"), age rating (the Brazilian
  ratings Crunchyroll provides: L, 10, 12, 14, 16, 18; "up to 14" includes L to 14; unrated
  series are excluded when the filter is on), category (several at once: a title shows up if
  it has any of them), release year and release season. When a result does not carry its
  categories, the extension asks Crunchyroll for the titles of each chosen category (one request
  per category, kept for 6 hours).
- **Sort:** Crunchyroll default, newest release or title. Results load 60 at a time.

### Firefox for Android

The same extension runs in Firefox for Android (it is marked compatible with
`browser_specific_settings.gecko_android`). Open it from Firefox's menu → **Extensions** →
**Watchroll**. Differences from the desktop:

- **Links open in the Crunchyroll app.** Series, episode, Watchlist and Crunchylist links are
  opened as Android `intent://` links for the official app (`com.crunchyroll.crunchyroid`),
  without the language prefix in the path. Without the app installed, Firefox opens the normal
  Crunchyroll page instead. The **Open Crunchyroll links in the Crunchyroll app** setting
  (shown only on Android, on by default) turns this off.
- The toolbar counter appears in Firefox's menu instead of the toolbar, and its colors may be
  ignored.
- The filter bar and the tabs wrap to fit a phone screen.
- Firefox for Android has no window API: opening the page only switches to its tab.

### Settings

Changes are saved immediately.

| Setting | What it does |
|---|---|
| Lists to check | Multi-select of your Watchlist and Crunchylists (names read from Crunchyroll). At least one stays selected. A series in several lists is checked once. A Crunchylist deleted on the site is ignored and shown as "List not found". |
| Extension language | One of 27 languages, each listed in its own language, or *Automatic* (Firefox's language; untranslated languages fall back to English). |
| Language you watch dubbed in | Dub language for dubbed-mode series and the dub indicator. Any of Crunchyroll's 24 audio languages; on a new install, the interface language (English if Crunchyroll has no such audio). |
| Subtitle language | Subtitles required before a subbed episode is announced. Same list and initial value as the dub language. |
| Default mode for series | Subbed, dubbed or any audio, for series without their own mode. |
| Language for titles and links | Language Crunchyroll uses for series and episode names, and for links. *Automatic* (default) follows the extension language; otherwise one of the 16 languages the Crunchyroll site supports (any other would make the API answer in English). Every API request of a check, the Advanced Search and the Crunchylist names use this same language, and changing it refreshes the results and the search. |
| Check automatically | Interval in minutes, any value from 5 to 1440 (default 60); 0 turns it off. |
| Notify me when a new episode is out | Desktop notifications (on by default). |
| Show specials and recaps | Shows them, tagged and uncounted (on by default). |
| Show "To watch" in compact mode | Rows instead of cards in *To watch* (off by default). |
| Show skipped episodes | Shows unwatched episodes before the last one you watched, tagged "skipped" and uncounted (off by default). Only for the seasons the check examines. |
| Also search Japanese and romaji names | Sends Advanced Search text to AniList (off by default). |
| Count as started after (seconds) | Ignores playback records shorter than this (default 60, 0–600). Crunchyroll records a few seconds just from opening an episode page. |
| Series checked at the same time | Parallel requests (default 4, 1–32). Lower it if you get HTTP 429 errors. |
| Batch size | Episodes per progress request and items per Watchlist/history page (default 100, 10–300). Lower it if checks start failing. |
| Settings backup | **Export** saves your settings (per-series modes, hidden series, lists, languages and options) to a JSON file; **Import** restores them and reloads the page. Unknown keys and values of the wrong type are ignored. No login, token or history is included. |

## How episodes are determined

For each series the extension:

1. reads the seasons and episodes (`/content/v2/cms/…`), newest season first;
2. reads your playback progress (`/content/v2/{account}/playheads`) for **every audio version**
   of each episode;
3. finds the last episode you touched and lists the **available** episodes after it that you
   haven't finished.

Rules:

- **Started:** at least the configured number of seconds played, or marked watched by
  Crunchyroll.
- **Watched:** Crunchyroll's `fully_watched`, or more than 90% of the duration, in any audio.
- **Subbed:** uses the original-audio episode list and requires subtitles in your subtitle
  language. If the API returns no subtitle list, the episode is announced.
- **Dubbed:** uses the episode list of your dub language and checks the audio of **each
  episode**, because Crunchyroll fills the dubbed list with the original version until the dub
  is out.
- **Any audio:** announces an episode as soon as any version is out.
- **Movies** in your lists are checked too: not started goes to *To start*, started to *To
  watch* with progress, finished to *Caught up*. Multi-part movies are listed part by part.
- **Not started shortcut:** before the per-series checks, the extension reads your watch
  history (`/content/v2/{account}/watch-history`, up to 10 pages). A series goes straight to
  *To start* only if the history was read to the end, the series has no real activity in it and
  Crunchyroll also flags it as never watched (that flag exists only for the Watchlist).
  Otherwise, the full check runs.

### Lists

- Watchlist: `/content/v2/discover/{account}/watchlist`.
- Crunchylist names: `/content/v2/{account}/custom-lists`; items:
  `/content/v2/{account}/custom-lists/{list}` (Crunchyroll caps each Crunchylist at 100 items).

### Speed and freshness

- Ratings come with the lists themselves: the Watchlist and Crunchylist requests ask for
  `ratings=true`, as the site's list pages do, and each item then carries its average and number
  of ratings. Only titles that arrive without one are looked up with
  `/content-reviews/v3/user/{account}/rating/series/{id}` (`movie_listing` for movies), the
  request the series page makes, after the check, and kept for 24 hours, so the list never
  waits for them.

- The Watchlist, the Crunchylists and the history are read at the same time, with their pages
  in parallel, up to the *Series checked at the same time* limit.
- Progress requests from several series are batched (up to *Batch size* episodes each).
- On HTTP 429 the extension waits as asked (`Retry-After`, otherwise 1, 2, 4, 8… up to 60 s)
  and retries up to 4 times; the pause applies to all requests in flight.
- Results are reused for 5 minutes without any request. From 5 minutes to 6 hours, a cheap
  revalidation (season list plus the latest season's episode list, and the shared history)
  reuses the previous result if nothing changed. After 6 hours, when a scheduled release time
  has passed, or on **Refresh**, the check is full.
- Links follow the site's own URL rule: no prefix for en-US; `/es-es`, `/pt-br`, `/pt-pt` and
  `/zh-tw` in full; the others by their first two letters (`/es`, `/fr`, `/de`…).
- Requests bypass Firefox's cache (`cache: "no-store"`) and use the same query parameters as the
  site, so Crunchyroll's CDN returns the copy the site keeps fresh instead of one up to about
  20 minutes old.

## Authentication and privacy

- No password is asked for or stored. The extension uses your Crunchyroll session in Firefox.
- `src/page-hook.js` runs on Crunchyroll pages and only reads the `Bearer` token the site
  itself uses. The token is kept in the browser's session memory.
- Without a recent site token, the extension requests one from `/auth/v1/token` with
  `grant_type=etp_rt_cookie`, as the site does on load.
- History is per profile, and the profile comes from the token. Cache, "already seen" episodes
  and the last result are stored per profile. With several profiles, the profile name is shown
  at the top. If the extension ends up using another profile's session, it warns you.
- The page calls the API directly. If Cloudflare blocks it, requests go through a
  crunchyroll.com tab via `src/bridge.js`; if none is open, one is opened in the background and
  closed afterwards (never during background checks).
- The background only accepts a token from a normal (non-private) crunchyroll.com tab, and
  only if it is a readable JWT.
- The extension does not run in private windows (`"incognito": "not_allowed"`), so nothing from
  private browsing is stored.
- Nothing is sent to third parties, except Advanced Search text to AniList when you enable it.
  See [PRIVACY.md](PRIVACY.md).

## Installation

**Temporary (for testing):** open `about:debugging#/runtime/this-firefox`, click **Load
Temporary Add-on…** and pick `manifest.json`. It is removed when Firefox closes.

**From source:**

```sh
git clone https://github.com/awmaximus/watchroll.git
cd watchroll
./build.sh            # dist/watchroll-<version>.zip
```

**Permanent:** install the version published on addons.mozilla.org, or a signed `.xpi` (see
[Build](#build)). Unsigned `.zip` packages are attached to each
[GitHub release](https://github.com/awmaximus/watchroll/releases). In Firefox Developer Edition or Nightly you can also set
`xpinstall.signatures.required` to `false` in `about:config` and install the `.zip`.

## Development

Requires Node 22 or later. No dependencies to install.

```sh
npm test        # unit tests (node:test)
npm run lint    # web-ext lint only
npm start       # opens a test Firefox with the extension loaded
```

### Build

```sh
./build.sh                  # tests + lint + package in dist/
./build.sh --skip-tests     # skip tests
./build.sh --skip-lint      # skip web-ext lint
./build.sh --sign           # also sign on AMO; the channel comes from the version (below)
./build.sh --sign --listed  # same, but refuses an odd version (safety check for releases)
```

**Odd versions are test builds, even versions are releases.** With `--sign`, the last number of
the version picks the AMO channel:

| Version | Channel | Result |
|---|---|---|
| odd (1.0.5) | `unlisted` | Signed right away; the installable `.xpi` goes to `dist/`. Test it locally. |
| even (1.0.6) | `listed` | Submitted to the public listing with `amo-metadata.json`. |

The flow: bump to the next odd version, `./build.sh --sign`, install the `.xpi` and test; if all
is well, bump to the next even version, commit, tag and `./build.sh --sign`. If something is
wrong, fix it and go to the next odd version.

The script stops at the first failure. It:

1. checks Node and that `manifest.json` and `package.json` have the same version;
2. checks script syntax and runs the tests;
3. copies **only** `manifest.json`, `_locales/`, `src/`, `dashboard/` and `icons/` to a temporary
   folder, without hidden files (add other paths to `PACKAGE_FILES`);
4. scans that folder for credentials (`user:123:45` keys, loaded key values, assignments like
   `API_SECRET="..."`) and aborts if it finds any;
5. runs `web-ext lint` with warnings as errors;
6. creates `dist/watchroll-<version>.zip` and, with `--sign`, uploads that same
   folder.

Signing needs the **JWT issuer** and **JWT secret** from
<https://addons.mozilla.org/developers/addon/api/key/>, in a `.amo-credentials` file (kept out
of git, `chmod 600`) or in environment variables (`API_KEY`/`API_SECRET`,
`AMO_JWT_ISSUER`/`AMO_JWT_SECRET` or `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET`):

```sh
cat > .amo-credentials <<'CRED'
API_KEY="user:12345:67"
API_SECRET="..."
CRED
chmod 600 .amo-credentials
```

Even versions send the store metadata in `amo-metadata.json`: summary and description in English
and Portuguese, category, the `streaming` tag, license, homepage and support links, and notes for
Mozilla's reviewers (without credentials). The script sends the version and returns right away (`--approval-timeout 0`); review takes
hours to days, and the signed `.xpi` appears in the Developer Hub once it is approved.
The store name and summary also come from `_locales/<code>/messages.json`, with English as the
manifest's `default_locale`.

Store search: addons.mozilla.org has no keyword field. Its search looks at the name, summary
and description, plus a fixed list of tags (only `streaming` applies here). So the search terms
(anime, episode tracker, new episodes, Watchlist, Crunchylists, sub/dub, release calendar,
simulcast, notifications) are written into the localized names and summaries in `_locales/` and
into the English and Portuguese descriptions in `amo-metadata.json`.

For the store listing, `store/screenshots/` has 1280×800 screenshots (English interface,
fictional titles and generated artwork) and `PRIVACY.md` is the privacy policy to paste in the
add-on's Developer Hub page. The listing icon is `icons/icon-128.png`.

Bump `version` in both `manifest.json` and `package.json` for every build you sign (current:
1.0.11); AMO does not accept the same version twice, not even in different channels, which is why
test builds and releases use different numbers. The add-on ID
(`crunchyroll-novos-eps@awmaximus.github.io`) comes from before the rename and must stay as it
is: changing it makes Firefox and AMO treat Watchroll as a different extension.

### Continuous integration

`.github/workflows/ci.yml` runs `./build.sh` (tests, lint, package) on every push and pull
request with Node 22 and keeps the `.zip` as a build artifact.

### Releases

Pushing a version tag publishes a GitHub release with the `.zip` attached:

```sh
# after bumping "version" in manifest.json and package.json (e.g. to 1.0.6)
git commit -am "Watchroll 1.0.6"
git tag v1.0.6
git push && git push origin v1.0.6
```

The release job checks that the tag matches the `manifest.json` version, then creates the
release `Watchroll v1.0.1` with notes generated from the commits (or replaces the `.zip` if the
release already exists). For a tag pushed before this workflow existed, use **Actions → CI → Run
workflow** with the tag name.

The release `.zip` is the unsigned package: it installs as a temporary add-on, or permanently in
Firefox Developer Edition/Nightly with signatures off. The regular way to install is the version
on addons.mozilla.org.

### Translations

Each language is `_locales/<code>/messages.json` (`en_US`, `pt_BR`, `es_419`, `zh_TW`…). Keys
ending in `_one`/`_other` are singular/plural. Tests check that every file has the same keys and
placeholders. Because `browser.i18n` only follows the browser language, `src/i18n.js` loads the
chosen file itself, with English as the fallback. To add a language, copy `en_US`, translate it,
add it to `LANGUAGES` in `src/i18n.js` (with its name in its own language) and run `npm test`.

### Project layout

```
manifest.json       MV3 manifest (Firefox)
amo-metadata.json   English store metadata for releases (even versions)
PRIVACY.md          privacy policy
store/screenshots/  store screenshots
.github/workflows/  CI
_locales/           interface texts, 27 languages
build.sh            tests, lint, package and signing
dashboard/          extension page (HTML, CSS, JS)
src/background.js   toolbar button, session token, periodic and release-time checks
src/checker.js      settings, icon counter, new-episode detection, notifications, release alerts
src/analyzer.js     "what's left to watch" logic, lists and cache
src/api.js          Crunchyroll API calls, authentication and transport
src/search.js       Advanced Search
src/i18n.js         translations and language selection
src/page-hook.js    reads the token used by the site (world: MAIN)
src/bridge.js       relays requests through a crunchyroll.com tab
tests/              unit and integration tests with mocked browser and API
```

### Diagnostics

If a series looks wrong, use **⋯ → Export diagnostics** on it. The page saves a JSON with
everything the check used (seasons, episodes, that series' playback history and the result),
without tokens, cookies, or account or profile IDs. Prefer it over copying requests from the
developer tools, which include your session. A diagnostics file can become a test with
`apiFromDiagnostic()` from `tests/helpers.js`.

When something breaks, open the page's console (F12); messages start with `[Watchroll]`.

| Symptom | Where to look |
|---|---|
| HTTP 401 or 403 | authentication in `src/api.js` |
| HTTP 404 or empty data | endpoint URLs in `src/api.js` |
| Wrong episodes | `analyzeSeries()` in `src/analyzer.js` |

## Contributing

Bug reports and pull requests are welcome at <https://github.com/awmaximus/watchroll/issues>.
Run `./build.sh` before sending a change; for a series that shows the wrong episodes, attach its
diagnostics file (never a HAR or request copied from the developer tools, which contain your
session).

## License

MIT. See [LICENSE](LICENSE).
