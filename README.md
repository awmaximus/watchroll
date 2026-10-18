# Crunchyroll – Novos Episódios (Firefox)

Extensão do Firefox com uma página própria que lista os episódios que você ainda não assistiu
das séries da sua **Fila** da Crunchyroll, com link direto para cada um.

Você também escolhe, série por série, se assiste **legendado** ou **dublado**. Uma série
marcada como dublada só aparece quando a dublagem no seu idioma for liberada.

A extensão **não altera o site da Crunchyroll**. Se o layout do site mudar, ela continua
funcionando. Só depende da API.

## Uso

1. Clique no ícone da extensão na barra do Firefox. A página "Novos episódios" abre.
2. Na aba **Configurações**, escolha:
   - o idioma em que você assiste dublado (por exemplo, Português (Brasil));
   - o idioma da legenda;
   - o modo padrão das séries (legendado, dublado ou qualquer áudio);
   - o idioma dos títulos e links;
   - a verificação automática (desligada, ou a cada 30 min, 1 h, 3 h ou 6 h; padrão 1 h) e
     se quer notificação de episódio novo;
   - quantas séries consultar ao mesmo tempo (padrão 4, de 1 a 32). Números maiores
     deixam a verificação mais rápida; se aparecerem erros HTTP 429 ("muitas
     requisições"), diminua;
   - o tamanho do lote (padrão 100, de 10 a 300): quantos episódios vão em cada consulta
     de playheads e quantos itens vêm em cada página da Fila e do histórico. Lotes maiores
     fazem menos consultas e, no histórico, cobrem mais registros (são lidas até 10
     páginas). Se as verificações começarem a falhar, diminua. Se a Crunchyroll devolver
     páginas menores que o pedido, a extensão relê a Fila ou o histórico com páginas de 100.
3. Cada card mostra um microfone com o idioma de dublagem escolhido: verde quando a
   temporada mais recente tem dublagem nesse idioma, amarelo tracejado quando só
   temporadas anteriores têm, e cinza riscado quando não há. Nas listas, aparece só o
   microfone. A informação vem da própria lista de temporadas, sem consultas a mais.
4. Em cada série, use o seletor para trocar o modo só daquela série. O menu **⋯** oculta a
   série (até sair episódio novo, por 1 semana ou sempre) ou exporta o diagnóstico.

Acima da lista há uma busca por título, que ignora acentos e maiúsculas e abre as seções
com resultado. Ao lado fica a ordenação dos cards de "Para assistir": lançamento mais
recente, visto mais recentemente, mais episódios ou título. A escolha fica salva.

A página é dividida em abas. Abas vazias não aparecem, exceto "Para assistir", "Em dia" e
"Ainda não começadas". A aba escolhida fica salva. Durante uma busca, se a aba atual não tiver
resultado, a página mostra a primeira que tiver. As setas ← e → trocam de aba pelo teclado.

| Aba | O que mostra |
|---|---|
| Para assistir | Episódios liberados depois do último que você viu, com progresso dos que estão pela metade |
| Aguardando dublagem | Séries em modo dublado com episódios que já saíram, mas ainda só legendados (a temporada já tem dublagem no seu idioma) |
| Aguardando legenda em … | Séries em modo legendado com episódios lançados sem legenda no seu idioma |
| Sem dublagem em … | Séries em modo dublado cuja temporada atual não tem **nenhum** episódio no seu idioma; o botão "Ver legendado" troca o modo |
| Não consegui verificar | Séries que deram erro na consulta |
| Ocultas | Séries que você ocultou pelo menu ⋯ (até sair episódio novo, por 1 semana ou sempre); não contam no ícone nem notificam |
| Em dia | Séries sem nada pendente |
| Ainda não começadas | Séries da Fila que você nunca assistiu, agrupadas pela temporada de lançamento (Outono de 2026, Verão de 2026…), da mais recente para a mais antiga. A temporada vem do `season_tags` da temporada mais recente da série; sem essa informação, a série vai para "Sem temporada informada" |
| Pesquisar | Busca no catálogo inteiro da Crunchyroll ou só na sua Fila, com filtros de dublagem no seu idioma, classificação indicativa, ano de estreia e temporada de lançamento (veja abaixo) |
| Configurações | Idiomas, modo padrão, verificação automática, limites e as demais opções; as mudanças são salvas na hora |

Antes de analisar as séries, a extensão lê o seu histórico de reprodução
(`/content/v2/{conta}/watch-history`, até 10 páginas de 100). Uma série vai direto para "Ainda
não começadas", sem nenhuma outra consulta, só quando três condições valem juntas: o histórico
foi lido até o fim, a série não aparece nele com atividade real e a própria Crunchyroll
também a marca como nunca vista. Em qualquer outro caso, inclusive se o histórico falhar, a
análise completa é feita.

Se a Crunchyroll responder HTTP 429 ("muitas requisições"), a extensão espera o tempo que
ela pedir (cabeçalho `Retry-After`; sem ele, 1 s, 2 s, 4 s, 8 s, até 60 s) e tenta de novo,
no máximo 4 vezes. A pausa vale para todas as consultas em andamento.

Os pedidos de histórico de reprodução (playheads) de várias séries são juntados em lotes de
até 100 episódios (configurável, de 10 a 300). Com 6 séries em paralelo, por exemplo, sai 1 consulta em vez de 6.

As séries são consultadas em paralelo, até o limite configurado. Dentro de cada série, as
temporadas são lidas da mais nova para a mais antiga e a busca para assim que encontra
atividade sua, para não fazer requisições à toa. Se o token vencer no meio da verificação,
as consultas em andamento esperam um único pedido de token novo.

A Fila e o histórico de reprodução são lidos ao mesmo tempo, e as páginas de cada um também
são pedidas juntas. Como o histórico não informa quantas páginas tem, a extensão pede várias de
uma vez e para na que indicar o fim. Ela também lembra quantas páginas havia da última vez,
para pedir exatamente essas de saída. Tudo isso respeita o limite de **Séries consultadas ao
mesmo tempo**. O histórico é lido até 10 páginas (1.000 registros).

### Verificação automática e contador no ícone

Em segundo plano, a extensão verifica no intervalo escolhido e mostra no ícone quantos
episódios novos há. Se sair algum que você ainda não viu na página, aparece uma notificação;
clicar nela abre a página. Detalhes:

- Na primeira verificação a extensão só registra o que já existe, sem notificar.
- O que você já viu na página não gera notificação depois.
- Em segundo plano ela nunca abre abas. Se o acesso direto à API for bloqueado e não houver
  uma aba do crunchyroll.com aberta, aquela verificação é pulada.
- Ao abrir a página, o último resultado aparece na hora e é atualizado em seguida.

Os resultados ficam em cache por 5 minutos, sem nenhuma consulta. Entre 5 minutos e 6 horas,
a extensão faz uma revalidação barata: busca a lista de temporadas da série e a lista de
episódios da temporada mais recente (2 consultas; 3 no modo dublado) e olha o histórico, que
é baixado uma vez para todas as séries. Se nada mudou (nenhuma temporada nova, nenhum episódio
novo ou liberado desde então, nenhuma dublagem ou legenda nova, nada assistido, nenhum
lançamento agendado que já passou), ela reaproveita a análise. Senão, analisa de novo. Depois
de 6 horas, ou ao clicar em **Atualizar**, a análise é sempre completa.

Todas as consultas vão direto ao servidor da Crunchyroll, sem passar pelo cache do Firefox
(`cache: "no-store"`): o cache chegou a devolver a lista de temporadas de antes do lançamento
de um episódio.

A lista de temporadas é pedida com os mesmos parâmetros, na mesma ordem, que o site usa
(`?locale=…&preferred_audio_language=…`, com o idioma de dublagem das Configurações). A CDN da
Crunchyroll guarda uma cópia por endereço exato e pode servir uma cópia de até ~20 minutos
(`stale-while-revalidate`). Com o endereço do site, a extensão pega a cópia que os outros
usuários renovam o tempo todo.

## Aba Pesquisar

- **Texto:** usa a busca da Crunchyroll (`/content/v2/discover/search`), que entende títulos
  em português e inglês. Em romaji ela só acerta quando o nome coincide com o título; em
  japonês (kanji/kana) não acha nada.
- **Nomes em japonês e romaji (opcional):** com a opção "Buscar também nomes em japonês e
  romaji" ligada nas Configurações, o texto da busca também vai para o
  [AniList](https://anilist.co), que devolve o link da série na Crunchyroll. Ex.:
  "薬屋のひとりごと" ou "Kusuriya no Hitorigoto" → Diários de uma Apotecária. A opção vem
  desligada e pede a permissão de envio dos termos de busca do Firefox.
- **Sem texto:** com temporada, lista o que a própria Crunchyroll marca naquela temporada
  (`seasonal_tag`); só a Fila, as séries da Fila; nos demais casos, a extensão baixa o
  **catálogo inteiro** (≈1.900 títulos, ~20 consultas em paralelo, menos de 1 s) e filtra tudo
  localmente. O catálogo fica guardado por 6 horas. Não dá para pegar só as primeiras páginas
  dos "populares" e filtrar: o ranking de popularidade da Crunchyroll está distorcido (Witch
  Hat Atelier, da primavera de 2026, vinha em 1.714º de 1.929) e o filtro `is_dubbed` do
  servidor está desatualizado (a mesma série, dublada em pt-BR, não aparece entre os
  "dublados").
- **Ordenar:** padrão da Crunchyroll, estreia mais recente ou título (A–Z). Os resultados
  aparecem de 60 em 60 ("Carregar mais").
- **Dublagem** confere o idioma de dublagem das Configurações (`audio_locales` de cada
  série), não só "tem alguma dublagem".
- **Classificação** usa a classificação indicativa brasileira que a Crunchyroll informa
  (L, 10, 12, 14, 16, 18); "Até 14 anos" mostra L, 10, 12 e 14. Séries sem classificação
  ficam de fora quando o filtro está ligado.
- A temporada de lançamento vem da lista oficial (`/content/v1/season_list`).

## Por que não usar o "A Seguir" da Crunchyroll

O estado que a Crunchyroll devolve para a Fila (`never_watched`, "A Seguir", "Começar a
assistir") às vezes está errado. A extensão não depende dele. Para cada série ela:

1. busca as temporadas e os episódios (`/content/v2/cms/...`);
2. busca o seu progresso real (`/content/v2/{conta}/playheads`) de **todas as versões de
   áudio** de cada episódio;
3. acha o último episódio em que você mexeu e lista os episódios **disponíveis** depois
   dele que você ainda não terminou.

Regras adotadas:

- **Começado:** só conta a partir de **1 minuto** de reprodução (configurável de 0 a 600
  segundos), ou se a Crunchyroll marcou como assistido. Ela cria registros com 0 ou poucos segundos só por você abrir a página do
  episódio ou pelo início automático do player; esses são ignorados.
- **Visto:** a Crunchyroll marcou `fully_watched`, ou você passou de 90% da duração.
  Vale para qualquer áudio: ver legendado conta para o modo dublado e vice-versa.
- **Legendado:** usa a lista de episódios do áudio original e só anuncia um episódio quando
  a legenda no idioma escolhido (Configurações → Idioma da legenda) já está disponível. Os
  que saíram sem ela aparecem em "Aguardando legenda". Se a resposta da API não trouxer a
  lista de legendas, o episódio é anunciado.
- **Dublado:** usa a lista de episódios do áudio escolhido. Um episódio só aparece depois
  que a dublagem dele é liberada. A extensão confere o áudio de **cada episódio**, porque a
  Crunchyroll completa a lista dublada com a versão original quando a dublagem ainda não
  saiu.
- **Qualquer áudio:** avisa assim que o episódio sair em qualquer versão.
- **Episódios pulados (opcional):** com "Mostrar episódios pulados" ligado, os episódios
  anteriores ao último que você viu e que ficaram sem ver aparecem com a etiqueta "pulado",
  fora das contagens. Vale para as temporadas que a extensão examina (a mais recente com
  atividade e as seguintes); pulados em temporadas antigas não aparecem.
- **Filmes:** filmes da Fila também são verificados. Não começado vai para "Ainda não
  começadas"; começado e não terminado, para "Para assistir" com o progresso; terminado,
  para "Em dia". Ver em qualquer áudio conta. O modo de áudio da série decide o link, e um
  filme em partes aparece parte por parte.
- **Próximo lançamento:** quando há episódio agendado, o card e as linhas mostram "Próximo:
  T2 E13 em 3 dias (qui, 16/10)". No modo dublado vale a data da dublagem. Datas fictícias
  (a Crunchyroll usa o ano 9998 para "sem data") são ignoradas.
- **Especiais e recapitulações:** episódios com numeração fora do normal (13.5, SP, OVA),
  sem número, com título de recapitulação, ou de temporadas especiais aparecem com uma
  etiqueta e **não entram** nas contagens (card, ícone, notificação). Temporadas especiais
  são ordenadas antes das normais, para não atrapalhar a busca pela temporada atual. Dá
  para escondê-los em Configurações.

## Instalação

Precisa do Firefox 142 ou mais recente.

**Para testar (temporário).** A extensão some ao fechar o Firefox.

1. Abra `about:debugging#/runtime/this-firefox`.
2. Clique em **Carregar extensão temporária…**.
3. Escolha o `manifest.json` deste repositório.

**Permanente.** O Firefox normal só instala extensões assinadas. Há duas formas:

- **Assinar sem publicar.** Crie uma conta em addons.mozilla.org e rode
  `./build.sh --sign` (veja [Build](#build)). O `.xpi` gerado só fica disponível para você
  e se instala normalmente.
- **Firefox Developer Edition ou Nightly.** Em `about:config`, mude
  `xpinstall.signatures.required` para `false` e instale o `.zip` gerado por `./build.sh`.

## Como funciona a autenticação

Nenhuma senha é pedida nem guardada. A extensão usa a sessão que você já tem aberta no
navegador.

- **Token do site.** `src/page-hook.js` roda dentro das páginas da Crunchyroll e só observa
  o token `Bearer` que o próprio site usa. Esse token fica guardado apenas na memória de
  sessão do navegador e não sai dele.
- **Token próprio.** Se não houver token recente, a extensão pede um em `/auth/v1/token`
  com `grant_type=etp_rt_cookie`. É o mesmo pedido que o site faz ao carregar, usando o
  cookie da sua sessão.
- **Perfis.** O histórico é por perfil, e o perfil vem do token. Por isso a extensão prefere
  o token do site, que é o do perfil aberto no navegador. Cache, "já visto" e último resultado
  são guardados por perfil. Se a conta tiver mais de um perfil, o nome dele aparece no topo
  da página. Se a extensão precisar usar uma sessão própria de outro perfil, ela avisa.
- **Acesso direto ou pela ponte.** A página da extensão tenta falar direto com a API. Se o
  Cloudflare bloquear, ela passa as requisições por uma aba do crunchyroll.com, usando
  `src/bridge.js`. Se não houver aba aberta, abre uma em segundo plano e a fecha no fim.

Os endpoints foram conferidos no código do crunchyroll-rs 0.19.1 (setembro de 2026). A API
não é oficial e pode mudar sem aviso.

## Desenvolvimento

Requer Node 22 ou mais recente. Não há dependências para instalar.

### Build

```sh
./build.sh                 # testes + lint + pacote em dist/
./build.sh --skip-tests    # pula os testes
./build.sh --skip-lint     # pula o web-ext lint
./build.sh --sign          # também gera o .xpi assinado (instalação permanente)
```

O script faz estas etapas, nesta ordem, e para na primeira falha:

1. confere o Node e se a versão do `manifest.json` bate com a do `package.json`;
2. verifica a sintaxe dos scripts;
3. roda os testes;
4. monta o pacote numa pasta temporária, **só** com `manifest.json`, `src/`, `dashboard/` e
   `icons/`, sem arquivos ocultos. Qualquer outro arquivo do projeto (por exemplo, um
   `env.sh` com as suas chaves) nunca entra no pacote;
5. procura credenciais no pacote: o formato `user:123:45`, os valores das chaves
   carregadas e atribuições como `API_SECRET="..."`. Se achar algo, aborta sem enviar nada;
6. roda o `web-ext lint` nessa pasta, tratando avisos como erros;
7. gera `dist/crunchyroll-novos-eps-<versão>.zip` e, com `--sign`, envia à Mozilla
   exatamente essa mesma pasta.

Para colocar outro arquivo na extensão, acrescente-o a `PACKAGE_FILES` no `build.sh`.

Para usar `--sign`, pegue a **JWT issuer** (API key) e o **JWT secret** (API secret) em
<https://addons.mozilla.org/developers/addon/api/key/>. Há duas formas de passá-las:

```sh
# 1) arquivo local, fora do git (recomendado)
cat > .amo-credentials <<'CRED'
API_KEY="user:12345:67"
API_SECRET="..."
CRED
chmod 600 .amo-credentials
./build.sh --sign

# 2) variáveis de ambiente (API_KEY/API_SECRET, AMO_JWT_ISSUER/AMO_JWT_SECRET
#    ou WEB_EXT_API_KEY/WEB_EXT_API_SECRET)
API_KEY="user:12345:67" API_SECRET="..." ./build.sh --sign
```

Se a Mozilla avisar que encontrou a sua chave e vai revogá-la, gere uma nova na mesma
página; a antiga deixa de funcionar.

A extensão é assinada no canal *unlisted*: fica instalável, mas não aparece na loja. Na
primeira assinatura, a Mozilla registra o ID `crunchyroll-novos-eps@awmaximus.github.io`.
Não mude esse ID depois, senão o Firefox passa a tratar a extensão como outra.

Para lançar uma versão nova, aumente `version` no `manifest.json` e no `package.json`.
A Mozilla não aceita assinar a mesma versão duas vezes.

### Outros comandos

```sh
npm test        # só os testes unitários (node:test)
npm run lint    # só a validação da Mozilla
npm start       # abre um Firefox de teste com a extensão carregada
```

Os testes ficam em `tests/` e rodam os scripts da extensão num contexto isolado, com a API
da Crunchyroll e a API `browser` simuladas:

- `analyzer.test.js` cobre a regra "o que falta assistir": temporadas, versões de áudio,
  modos legendado, dublado e qualquer áudio, cache, erros e o limite de séries em paralelo.
- `integration.test.js` roda o analisador e a API reais juntos, com só o `fetch` simulado.
- `api.test.js` cobre a autenticação, o token expirado, a renovação em erro 401, a troca
  para a ponte quando o Cloudflare bloqueia, a paginação, os lotes de playheads e as
  requisições simultâneas (um só pedido de token e uma só aba).

O GitHub Actions roda o `./build.sh` a cada push e guarda o `.zip` como artefato
(`.github/workflows/ci.yml`).

### Idioma da interface

A interface segue a língua do Firefox: português (padrão) ou inglês. Isso vale para a
página, o ícone, as notificações e as mensagens de erro. Os textos ficam em
`_locales/<língua>/messages.json`. Para adicionar uma língua, copie a pasta `pt_BR`, traduza
as mensagens (chaves `_one`/`_other` são singular e plural) e rode `npm test`. Os testes
conferem se as chaves e os marcadores batem com os do português.

A configuração **Idioma dos títulos e links** é outra coisa: ela escolhe em que língua a
Crunchyroll devolve os nomes das séries e dos episódios.

### Estrutura

```
manifest.json           MV3, Firefox
_locales/               textos da interface (pt_BR padrão, en)
build.sh                build: testes, lint, pacote e assinatura
dashboard/              página da extensão (HTML, CSS, JS)
src/background.js       botão, token da sessão e verificação automática (alarme)
src/i18n.js             traduções (t, plural, nome dos idiomas)
src/checker.js          preferências, contador do ícone, novidades e notificação
src/page-hook.js        observa o token usado pelo site (world: MAIN)
src/bridge.js           ponte invisível para requisições pelo crunchyroll.com
src/api.js              chamadas à API, autenticação e transporte
src/analyzer.js         lógica "o que falta assistir" e cache
tests/                  testes unitários
```

### Diagnóstico de uma série

Se uma série aparecer errada, use **⋯ → Exportar diagnóstico** no card dela. A página salva um
JSON com tudo o que a análise usou: temporadas, episódios, histórico de reprodução daquela
série e o resultado. O arquivo **não contém** token, cookie, ID da conta ou do perfil.
Prefira mandá-lo em vez de copiar requisições do F12, que levam a sua sessão junto.

O diagnóstico vira teste automático com `apiFromDiagnostic()` de `tests/helpers.js`:

```js
const diag = require("./fixtures/meu-diagnostico.json");
const ctx = load(["src/analyzer.js"], { browser: fakeBrowser(), CRApi: apiFromDiagnostic(diag) });
const [r] = await ctx.CRAnalyzer.run({ settings: { ...diag.configuracao, defaultMode: diag.configuracao.modo, seriesModes: {} } });
```

### Se algo parar de funcionar

Abra o console da página da extensão (F12). Os erros aparecem com o prefixo
`[Novos Episódios]`.

| Sintoma | Onde mexer |
|---|---|
| Erro 401 ou 403 | autenticação em `src/api.js` |
| Erro 404 ou dados vazios | URLs dos endpoints em `src/api.js` |
| Episódios errados | `analyzeSeries()` em `src/analyzer.js` |

## Aviso

Projeto pessoal, sem relação com a Crunchyroll. Usa uma API não documentada e só lê dados
da sua própria conta.
