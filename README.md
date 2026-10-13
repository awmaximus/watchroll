# Crunchyroll – Novos Episódios (Firefox)

Extensão do Firefox com uma página própria que lista os episódios que você ainda não assistiu
das séries da sua **Fila** da Crunchyroll, com link direto para cada um.

Você também escolhe, série por série, se assiste **legendado** ou **dublado**. Uma série
marcada como dublada só aparece quando a dublagem no seu idioma for liberada.

A extensão **não altera o site da Crunchyroll**. Se o layout do site mudar, ela continua
funcionando. Só depende da API.

## Uso

1. Clique no ícone da extensão na barra do Firefox. A página "Novos episódios" abre.
2. Em **Configurações**, escolha:
   - o idioma em que você assiste dublado (por exemplo, Português (Brasil));
   - o modo padrão das séries (legendado, dublado ou qualquer áudio);
   - o idioma dos títulos e links;
   - quantas séries consultar ao mesmo tempo (padrão 4, de 1 a 16). Números maiores
     deixam a verificação mais rápida; se aparecerem erros HTTP 429 ("muitas
     requisições"), diminua.
3. Em cada série, use o seletor para trocar o modo só daquela série.

A página tem estas seções:

| Seção | O que mostra |
|---|---|
| Para assistir | Episódios liberados depois do último que você viu, com progresso dos que estão pela metade |
| Aguardando dublagem | Séries em modo dublado com episódios que já saíram, mas ainda só legendados (a temporada já tem dublagem no seu idioma) |
| Sem dublagem em … | Séries em modo dublado cuja temporada atual não tem **nenhum** episódio no seu idioma; o botão "Ver legendado" troca o modo |
| Não consegui verificar | Séries que deram erro na consulta |
| Em dia | Séries sem nada pendente |
| Ainda não começadas | Séries da Fila que você nunca assistiu |

As séries são consultadas em paralelo, até o limite configurado. Dentro de cada série, as
temporadas são lidas da mais nova para a mais antiga e a busca para assim que encontra
atividade sua, para não fazer requisições à toa. Se o token vencer no meio da verificação,
as consultas em andamento esperam um único pedido de token novo.

Os resultados ficam em cache por 20 minutos. O botão **Atualizar** força uma nova consulta.

## Por que não usar o "A Seguir" da Crunchyroll

O estado que a Crunchyroll devolve para a Fila (`never_watched`, "A Seguir", "Começar a
assistir") às vezes está errado. A extensão não depende dele. Para cada série ela:

1. busca as temporadas e os episódios (`/content/v2/cms/...`);
2. busca o seu progresso real (`/content/v2/{conta}/playheads`) de **todas as versões de
   áudio** de cada episódio;
3. acha o último episódio em que você mexeu e lista os episódios **disponíveis** depois
   dele que você ainda não terminou.

Regras adotadas:

- **Começado:** só conta a partir de **1 minuto** de reprodução, ou se a Crunchyroll marcou
  como assistido. Ela cria registros com 0 ou poucos segundos só por você abrir a página do
  episódio ou pelo início automático do player; esses são ignorados.
- **Visto:** a Crunchyroll marcou `fully_watched`, ou você passou de 90% da duração.
  Vale para qualquer áudio: ver legendado conta para o modo dublado e vice-versa.
- **Legendado:** usa a lista de episódios do áudio original.
- **Dublado:** usa a lista de episódios do áudio escolhido. Um episódio só aparece depois
  que a dublagem dele é liberada. A extensão confere o áudio de **cada episódio**, porque a
  Crunchyroll completa a lista dublada com a versão original quando a dublagem ainda não
  saiu.
- **Qualquer áudio:** avisa assim que o episódio sair em qualquer versão.

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
- `api.test.js` cobre a autenticação, o token expirado, a renovação em erro 401, a troca
  para a ponte quando o Cloudflare bloqueia, a paginação, os lotes de playheads e as
  requisições simultâneas (um só pedido de token e uma só aba).

O GitHub Actions roda o `./build.sh` a cada push e guarda o `.zip` como artefato
(`.github/workflows/ci.yml`).

### Estrutura

```
manifest.json           MV3, Firefox
build.sh                build: testes, lint, pacote e assinatura
dashboard/              página da extensão (HTML, CSS, JS)
src/background.js       abre a página pelo botão e guarda o token da sessão
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
