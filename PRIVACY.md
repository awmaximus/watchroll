# Privacy Policy – Watchroll

Last updated: October 18, 2026

Watchroll – New Episodes for Crunchyroll ("the extension") is an unofficial Firefox extension. It is not
affiliated with or endorsed by Crunchyroll.

## Summary

- The extension has no servers of its own and collects no analytics or telemetry.
- It only talks to Crunchyroll, using your own session, to read your lists and watch progress.
- Everything it stores stays in your Firefox profile.
- The only optional third party is AniList, and only if you turn that option on.
- It does not run in private windows, so nothing from private browsing is read or stored.

## Data the extension reads

To show which episodes you haven't watched, the extension reads from Crunchyroll
(`www.crunchyroll.com`), with the session you already have in Firefox:

- your Watchlist and, if you select them, your Crunchylists (names and series);
- your watch history and playback progress;
- public catalog data: series, seasons, episodes, release dates, audio and subtitle languages,
  age ratings, categories and the average user rating of each title.

These requests go directly from your browser to Crunchyroll, the same way the Crunchyroll
website does. The extension never asks for, reads or stores your password.

## Data stored on your device

The extension stores the following in Firefox's extension storage, on your device only:

- your settings (languages, per-series modes, hidden series, selected lists, display options);
- the last check result and a short-lived cache of Crunchyroll data, to show results quickly;
- the episodes already shown or notified, so the same episode doesn't trigger two alerts;
- the access token the Crunchyroll website itself uses, kept in session memory only and
  discarded when Firefox closes.

This data is never sent anywhere else. Removing the extension deletes it. **Settings → Export**
creates a file with your settings only (no login data, tokens or history); the file stays
wherever you save it.

## Optional: AniList

Advanced Search can also look up Japanese and romaji titles. This is **off by default**. If you
turn on *Also search Japanese and romaji names*, Firefox asks for permission to share search
terms, and then the text you type in Advanced Search is sent to AniList (`graphql.anilist.co`)
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
