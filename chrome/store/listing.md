# Chrome Web Store listing

Texts to paste in the Chrome Web Store developer console. The store name and the short
description come from the manifest (`extName` and `extDescriptionShort` in
`common/_locales/`), translated into 27 languages.

## Store listing

**Category:** Entertainment

**Language:** English (add Portuguese (Brazil) with the text below)

**Description (English):**

```
Watchroll is an unofficial episode tracker for Crunchyroll. One page shows, for every series in your Watchlist and in the Crunchylists you choose, the episodes released after the last one you watched: what to watch next, what's coming this week and when the next episode drops.

Features
- New episodes based on your real watch progress, not on Crunchyroll's "Up Next".
- Sub or dub per series: a dubbed series only shows a new episode once the dub in your language is out; a subbed one, once subtitles in your language are available.
- Notifications and a counter on the toolbar icon, with an extra check right after each simulcast release time.
- Week tab: the next 7 days of releases. Crunchyroll only lists an episode once it's out, so simulcast times are estimated from the weekly pace. Series releasing in the next few hours get a countdown.
- Tabs: To watch, Dub pending, Subs pending, Caught up, Week, To start (grouped by anime season), Errors and Hidden, each with its own sorting.
- Filter bar on every tab: list, category (pick several) and sub/dub.
- Crunchyroll rating and categories (Action, Fantasy, Romance…) on every series.
- Advanced Search over the whole Crunchyroll catalog or only your lists, filtered by dub, category, minimum number of seasons, age rating, year and season. Optional Japanese and romaji title search through AniList.
- Hide or snooze a series, compact mode, settings export and import.
- Interface in 27 languages; series titles and links in the language you choose.

Privacy
Watchroll uses Crunchyroll's own API with the session you already have in your browser, only to read your lists, watch history and playback progress. If Crunchyroll blocks direct access, it may open a Crunchyroll tab in the background and close it when done (never during automatic checks). It does not change anything on Crunchyroll, has no servers of its own, collects no analytics and sends nothing to third parties. The only exception is optional: with AniList search turned on, the Advanced Search text is sent to AniList. It does not run in incognito windows.

Watchroll is not affiliated with or endorsed by Crunchyroll.
```

**Descrição (Português do Brasil):**

```
O Watchroll é um rastreador de episódios não oficial para a Crunchyroll. Uma página mostra, para cada série da sua Fila e das Crunchylists que você escolher, os episódios lançados depois do último que você viu: o que assistir agora, o que sai nesta semana e quando chega o próximo episódio.

Funções
- Episódios novos com base no seu progresso real, e não no "A Seguir" da Crunchyroll.
- Legendado ou dublado, série por série: uma série dublada só mostra episódio novo quando a dublagem no seu idioma sai; uma legendada, quando a legenda no seu idioma fica disponível.
- Notificações e contador no ícone, com uma verificação extra logo depois do horário de cada simulcast.
- Aba Semana: os lançamentos dos próximos 7 dias. Como a Crunchyroll só mostra o episódio quando ele sai, os horários de simulcast são previstos pelo ritmo semanal. Séries que estreiam nas próximas horas ganham contagem regressiva.
- Abas: Para assistir, Dub pendente, Legenda pendente, Em dia, Semana, A iniciar (por temporada de anime), Erros e Ocultas, cada uma com sua ordenação.
- Barra de filtros em todas as abas: lista, categoria (várias de uma vez) e legendado/dublado.
- Nota e categorias da Crunchyroll (Ação, Fantasia, Romance…) em todas as séries.
- Pesquisa no catálogo inteiro da Crunchyroll ou só nas suas listas, com filtros de dublagem, categoria, número mínimo de temporadas, classificação indicativa, ano e temporada. Busca opcional por nomes em japonês e romaji pelo AniList.
- Ocultar ou adiar séries, modo compacto, exportar e importar configurações.
- Interface em 27 idiomas; títulos e links no idioma que você escolher.

Privacidade
O Watchroll usa a própria API da Crunchyroll com a sessão que você já tem no navegador, só para ler suas listas, histórico e progresso. Se a Crunchyroll bloquear o acesso direto, ele pode abrir uma aba da Crunchyroll em segundo plano e fechá-la no fim (nunca nas verificações automáticas). Não altera nada na Crunchyroll, não tem servidores próprios, não coleta estatísticas e não envia nada a terceiros. A única exceção é opcional: com a busca pelo AniList ligada, o texto da Pesquisa vai para o AniList. Não funciona em janelas anônimas.

O Watchroll não tem relação com a Crunchyroll nem é endossado por ela.
```

**Graphics:** icon `common/icons/icon-128.png`; screenshots (1280×800) from
`firefox/store/screenshots/`. A small promo tile (440×280) is optional.

**Homepage / support:** <https://github.com/awmaximus/watchroll> ·
<https://github.com/awmaximus/watchroll/issues>

## Privacy practices tab

**Single purpose:**

```
Shows which episodes of the anime in your Crunchyroll Watchlist and Crunchylists you haven't watched yet, and notifies you when new ones are released.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings, the last check result and a short-lived cache on the device; the Crunchyroll access token is kept only in session storage. |
| `scripting` | When Crunchyroll blocks direct API access, injects the extension's own relay script into the user's crunchyroll.com tab so requests use the site's session. |
| `alarms` | Schedules the periodic background check and an extra check right after each known release time. |
| `notifications` | Shows a desktop notification when a new episode of a series in the user's lists is out. |
| Host `https://www.crunchyroll.com/*` | Reads the user's Watchlist, Crunchylists, watch history and the public catalog through Crunchyroll's API, and runs the content scripts that pick up the site's session token. |

**Remote code:** No, I am not using remote code (all scripts are in the package).

**Data usage:** declare **Authentication information** (the Crunchyroll session token, used only
to call Crunchyroll and kept in session memory) and **Web history** only if the form asks about
reading the user's Crunchyroll watch history (read from Crunchyroll, never sent anywhere else).
Certify that data is not sold, not used for unrelated purposes and not used for
creditworthiness.

**Privacy policy URL:** <https://github.com/awmaximus/watchroll/blob/main/PRIVACY.md>
