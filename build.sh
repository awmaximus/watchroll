#!/usr/bin/env bash
# Build da extensão Watchroll.
#
# Uso:
#   ./build.sh                 testes + lint + pacote .zip em dist/
#   ./build.sh --skip-tests    pula os testes unitários
#   ./build.sh --skip-lint     pula o web-ext lint
#   ./build.sh --sign          também assina na Mozilla e gera o .xpi instalável
#   ./build.sh --sign --listed envia para a loja pública (addons.mozilla.org), com os
#                              metadados em inglês de amo-metadata.json
#   ./build.sh --help
#
# Assinatura (--sign): use a "JWT issuer" (API key) e o "JWT secret" (API secret) de
#   https://addons.mozilla.org/developers/addon/api/key/
# de um destes jeitos:
#   a) variáveis de ambiente (qualquer um dos pares):
#        export API_KEY="user:12345:67"   API_SECRET="..."
#        export AMO_JWT_ISSUER="..."      AMO_JWT_SECRET="..."
#        export WEB_EXT_API_KEY="..."     WEB_EXT_API_SECRET="..."
#   b) arquivo .amo-credentials na raiz do projeto (fica fora do git):
#        API_KEY="user:12345:67"
#        API_SECRET="..."
# Sem --listed, o canal é "unlisted": a extensão é assinada mas não fica pública na loja.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
WEB_EXT="web-ext@10"
MIN_NODE=22

RUN_TESTS=1
RUN_LINT=1
SIGN=0
CHANNEL=unlisted

# ---------- saída ----------
if [[ -t 1 ]]; then
  BOLD=$'\e[1m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()   { printf '%s✔ %s%s\n' "$GREEN" "$1" "$RESET"; }
warn() { printf '%s! %s%s\n' "$YELLOW" "$1" "$RESET" >&2; }
die()  { printf '%s✘ %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

# ---------- argumentos ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests) RUN_TESTS=0 ;;
    --skip-lint)  RUN_LINT=0 ;;
    --sign)       SIGN=1 ;;
    --listed)     CHANNEL=listed ;;
    -h|--help)    usage; exit 0 ;;
    *) usage >&2; die "Opção desconhecida: $1" ;;
  esac
  shift
done

cd "$ROOT"

# ---------- requisitos ----------
step "Conferindo requisitos"
command -v node >/dev/null || die "Node.js não encontrado. Instale o Node $MIN_NODE ou mais recente."
command -v npx  >/dev/null || die "npx não encontrado (vem junto com o Node.js/npm)."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= MIN_NODE )) || die "Node $MIN_NODE+ necessário (encontrado: $(node --version))."
ok "Node $(node --version)"

[[ -f manifest.json ]] || die "manifest.json não encontrado em $ROOT."

# Versão vem do manifest; package.json precisa bater com ela.
# shellcheck disable=SC2016  # ${...} abaixo é template literal do JavaScript
read -r NAME VERSION < <(node -e '
  const m = require("./manifest.json");
  process.stdout.write(`${require("./package.json").name} ${m.version}\n`);
')
PKG_VERSION="$(node -p 'require("./package.json").version')"
[[ "$VERSION" == "$PKG_VERSION" ]] ||
  die "Versões diferentes: manifest.json=$VERSION, package.json=$PKG_VERSION. Ajuste antes do build."
ok "Versão $VERSION"

if [[ "$CHANNEL" == listed ]]; then
  (( SIGN )) || die "--listed só vale junto com --sign."
  [[ -f amo-metadata.json ]] || die "amo-metadata.json não encontrado (metadados da loja)."
  node -e 'JSON.parse(require("fs").readFileSync("amo-metadata.json","utf8"))' || die "amo-metadata.json inválido."
fi

if (( SIGN )); then
  CRED_FILE="$ROOT/.amo-credentials"
  if [[ -f "$CRED_FILE" ]]; then
    perms="$(stat -c '%a' "$CRED_FILE" 2>/dev/null || stat -f '%Lp' "$CRED_FILE")"
    [[ "$perms" =~ ^[0-7]00$ ]] ||
      warn ".amo-credentials pode ser lido por outros usuários. Rode: chmod 600 .amo-credentials"
    # shellcheck source=/dev/null
    source "$CRED_FILE"
  fi
  SIGN_KEY="${API_KEY:-${AMO_JWT_ISSUER:-${WEB_EXT_API_KEY:-}}}"
  SIGN_SECRET="${API_SECRET:-${AMO_JWT_SECRET:-${WEB_EXT_API_SECRET:-}}}"
  [[ -n "$SIGN_KEY" && -n "$SIGN_SECRET" ]] ||
    die "--sign precisa da API key e do API secret da Mozilla (veja ./build.sh --help)."
  [[ "$SIGN_KEY" == user:* ]] ||
    warn "A API key costuma ter o formato user:12345:67. Confira se não trocou key e secret."
  ok "Credenciais da Mozilla encontradas"
fi

# ---------- verificação de sintaxe ----------
step "Verificando sintaxe dos scripts"
while IFS= read -r -d '' f; do
  node --check "$f" || die "Erro de sintaxe em $f"
done < <(find src dashboard -name '*.js' -print0)
node -e 'JSON.parse(require("fs").readFileSync("manifest.json","utf8"))' || die "manifest.json inválido."
ok "Sintaxe OK"

# ---------- testes ----------
if (( RUN_TESTS )); then
  step "Rodando testes unitários"
  node --test --test-reporter=spec "tests/*.test.js" ||
    die "Testes falharam. Corrija antes do build (ou use --skip-tests)."
  ok "Testes passaram"
else
  warn "Testes pulados (--skip-tests)"
fi

# ---------- montagem (lista do que ENTRA no pacote) ----------
# Só estes caminhos vão para o pacote e para a Mozilla. Qualquer outro arquivo do
# projeto (env.sh, .env, anotações, credenciais...) fica de fora automaticamente.
PACKAGE_FILES=(manifest.json _locales src dashboard icons)

step "Montando o pacote numa pasta limpa"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/extensao"
ARTIFACTS="$WORK/artifacts"
mkdir -p "$STAGE" "$ARTIFACTS"
for item in "${PACKAGE_FILES[@]}"; do
  [[ -e "$item" ]] || die "Arquivo esperado não encontrado: $item"
  cp -R "$item" "$STAGE/"
done
# Sem arquivos ocultos (ex.: .env esquecido dentro de src/).
find "$STAGE" -name '.*' -exec rm -rf {} +
ok "$(find "$STAGE" -type f | wc -l | tr -d ' ') arquivos: ${PACKAGE_FILES[*]}"

# ---------- varredura de segredos ----------
step "Procurando segredos no pacote"
leaks=""
# Formato das chaves da Mozilla (JWT issuer): user:12345:67
if hits="$(grep -rIlE 'user:[0-9]+:[0-9]+' "$STAGE")"; then leaks+="$hits"$'\n'; fi
# Os valores reais das credenciais, se estiverem carregados.
for value in "${SIGN_KEY:-}" "${SIGN_SECRET:-}" "${API_KEY:-}" "${API_SECRET:-}" \
  "${AMO_JWT_ISSUER:-}" "${AMO_JWT_SECRET:-}" "${WEB_EXT_API_KEY:-}" "${WEB_EXT_API_SECRET:-}"; do
  [[ ${#value} -ge 8 ]] || continue
  if hits="$(grep -rIlF -- "$value" "$STAGE")"; then leaks+="$hits"$'\n'; fi
done
# Nomes de variáveis de credencial com valor atribuído.
if hits="$(grep -rIlE '(API_SECRET|JWT_SECRET|API_KEY|JWT_ISSUER)[[:space:]]*[:=][[:space:]]*["'\''][^"'\'' ]{8,}' "$STAGE")"; then
  leaks+="$hits"$'\n'
fi
if [[ -n "${leaks//$'\n'/}" ]]; then
  printf '%s\n' "$leaks" | sort -u | sed '/^$/d' | sed "s|^$STAGE/|  - |" >&2
  die "Possível credencial dentro do pacote (arquivos acima). Nada foi enviado."
fi
ok "Nenhuma credencial encontrada"

# ---------- lint ----------
if (( RUN_LINT )); then
  step "Validando com web-ext lint"
  npx --yes "$WEB_EXT" lint --no-config-discovery --source-dir "$STAGE" --warnings-as-errors ||
    die "Lint encontrou problemas (ou use --skip-lint)."
  ok "Lint sem erros nem avisos"
else
  warn "Lint pulado (--skip-lint)"
fi

# ---------- pacote ----------
step "Gerando pacote"
mkdir -p "$DIST"
npx --yes "$WEB_EXT" build --no-config-discovery --source-dir "$STAGE" \
  --artifacts-dir "$ARTIFACTS" --overwrite-dest >/dev/null
built="$(find "$ARTIFACTS" -maxdepth 1 -name '*.zip' | head -n1)"
[[ -n "$built" ]] || die "web-ext não gerou o .zip."

ZIP="$DIST/$NAME-$VERSION.zip"
mv -f "$built" "$ZIP"
ok "$(unzip -Z1 "$ZIP" | grep -vc '/$') arquivos em ${ZIP#"$ROOT"/} ($(du -h "$ZIP" | cut -f1))"

# ---------- assinatura ----------
if (( SIGN )); then
  step "Assinando na Mozilla (canal $CHANNEL)"
  META_ARGS=()
  [[ "$CHANNEL" == listed ]] && META_ARGS=(--amo-metadata "$ROOT/amo-metadata.json")
  # Envia exatamente a pasta conferida acima. Credenciais vão por variável de
  # ambiente (não aparecem na lista de processos).
  WEB_EXT_API_KEY="$SIGN_KEY" WEB_EXT_API_SECRET="$SIGN_SECRET" \
    npx --yes "$WEB_EXT" sign --no-config-discovery --source-dir "$STAGE" \
    --artifacts-dir "$ARTIFACTS" --channel "$CHANNEL" ${META_ARGS[@]+"${META_ARGS[@]}"} ||
    die "Falha ao assinar. Confira as credenciais. Se a Mozilla disse que a versão $VERSION já existe: ela não aceita repetir versão nem em outro canal (--sign e --sign --listed gastam um número cada); suba a versão no manifest.json e no package.json."
  signed="$(find "$ARTIFACTS" -maxdepth 1 -name '*.xpi' | head -n1)"
  if [[ -z "$signed" && "$CHANNEL" == listed ]]; then
    # Na loja pública a versão passa pela revisão da Mozilla antes de ser assinada.
    warn "Enviado para a loja; o .xpi fica disponível depois da revisão da Mozilla."
    XPI=""
  else
    [[ -n "$signed" ]] || die "A assinatura não gerou o .xpi."
    XPI="$DIST/$NAME-$VERSION.xpi"
    mv -f "$signed" "$XPI"
    ok "Assinado: ${XPI#"$ROOT"/}"
  fi
fi

# ---------- resumo ----------
step "Pronto"
echo "  Pacote: $ZIP"
[[ -n "${XPI:-}" ]] && echo "  Instalável: $XPI"
cat <<'EOF'

  Para testar: Firefox → about:debugging#/runtime/this-firefox
               → "Carregar extensão temporária…" → escolha o .zip
EOF
(( SIGN )) || echo "  Para instalar de forma permanente, rode com --sign."
