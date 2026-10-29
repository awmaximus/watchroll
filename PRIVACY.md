# Privacy Policy – Watchroll

Last updated: October 29, 2026

Watchroll – New Episodes for Crunchyroll ("the extension") is an unofficial browser extension for Firefox and for Chrome and
Chromium-based browsers (Edge, Brave, Opera, Vivaldi). It is not
affiliated with or endorsed by Crunchyroll.

## Summary

- The extension has no servers of its own and collects no analytics or telemetry.
- It only talks to Crunchyroll, using your own session, to read your lists and watch progress.
- Everything it stores stays in your browser profile; your settings are also synced to your
  other computers through the browser's own sync, if you use it.
- The only optional third party is AniList, and only if you turn that option on.
- It does not run in private windows, so nothing from private browsing is read or stored.

## Data the extension reads

To show which episodes you haven't watched, the extension reads from Crunchyroll
(`www.crunchyroll.com`), with the session you already have in your browser:

- your Watchlist and, if you select them, your Crunchylists (names and series);
- your watch history and playback progress;
- public catalog data: series, seasons, episodes, release dates, audio and subtitle languages,
  age ratings, categories and the average user rating of each title.

These requests go directly from your browser to Crunchyroll, the same way the Crunchyroll
website does. The extension never asks for, reads or stores your password.

## Data stored on your device

The extension stores the following in the browser's extension storage, on your device only:

- your settings (languages, per-series modes, hidden series, selected lists, display options);
- the last check result and a short-lived cache of Crunchyroll data, to show results quickly;
- the episodes already shown or notified, so the same episode doesn't trigger two alerts;
- the access token the Crunchyroll website itself uses, kept in session memory only and
  discarded when the browser closes.

Your **settings** (the first item above, except the open tab and filters) are also saved in the
browser's sync storage. If you are signed in to Firefox Sync or to Chrome with sync on, the
browser carries them to your other computers, through Mozilla's or Google's sync service and
under their privacy policies (Firefox Sync encrypts this data). The token, watch history, results
and cache are never synced. Without a browser account, sync storage stays on your device.

Apart from that, this data is never sent anywhere else. Removing the extension deletes it. **Settings → Export**
creates a file with your settings only (no login data, tokens or history); the file stays
wherever you save it.

## Optional: AniList

Advanced Search can also look up Japanese and romaji titles. This is **off by default**. If you
turn on *Also search Japanese and romaji names* (in Firefox, the browser asks for permission to
share search terms), then the text you type in Advanced Search is sent to AniList (`graphql.anilist.co`)
to find the matching title. Nothing else is sent: no account data, lists or history. AniList's
own privacy policy applies to that request. You can turn the option off at any time.

## Diagnostics

**⋯ → Export diagnostics** saves, on your device, a file with the catalog data and your
progress for one series, without tokens, cookies, or account or profile IDs. It is only shared
if you choose to send it to someone.

## Changes

Changes to this policy will be published with new versions of the extension and on its page on
addons.mozilla.org. Questions can be sent through that page or at
<https://github.com/awmaximus/watchroll/issues>.
