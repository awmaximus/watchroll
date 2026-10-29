#!/usr/bin/env bash
# Build da extensão Watchroll para o Google Chrome e navegadores baseados no
# Chromium (Edge, Brave, Opera, Vivaldi…).
#
# O pacote junta o código comum a todos os navegadores (common/) com o que é só do
# Chrome (chrome/: manifest.json e service-worker.js). O .zip gerado é o que se envia
# ao Chrome Web Store (ou se carrega em chrome://extensions → "Carregar sem compactação",
# depois de descompactar).
#
# Uso:
#   ./build-chrome.sh                testes + verificações + pacote .zip em chrome/dist/
#   ./build-chrome.sh --skip-tests   pula os testes unitários
#   ./build-chrome.sh --check        também carrega a extensão num Chromium de teste
#                                    (precisa do Playwright: npx playwright install chromium)
#                                    e falha se o service worker ou a página derem erro
#   ./build-chrome.sh --help

set -euo pipefail

# O script fica em chrome/; a raiz do repositório é a pasta acima dele.
BROWSER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # só do Chrome
ROOT="$(cd "$BROWSER/.." && pwd)"
COMMON="$ROOT/common"     # código comum aos navegadores
MANIFEST="$BROWSER/manifest.json"
DIST="$BROWSER/dist"      # pacotes gerados, fora do git
MIN_NODE=22

RUN_TESTS=1
CHECK=0

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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests) RUN_TESTS=0 ;;
    --check)      CHECK=1 ;;
    -h|--help)    usage; exit 0 ;;
    *) usage >&2; die "Opção desconhecida: $1" ;;
  esac
  shift
done

cd "$ROOT"

# ---------- requisitos ----------
step "Conferindo requisitos"
command -v node >/dev/null || die "Node.js não encontrado. Instale o Node $MIN_NODE ou mais recente."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= MIN_NODE )) || die "Node $MIN_NODE+ necessário (encontrado: $(node --version))."
ok "Node $(node --version)"
[[ -f "$MANIFEST" ]] || die "manifest.json não encontrado em $BROWSER."
[[ -d "$COMMON" ]] || die "Pasta common/ não encontrada em $ROOT."

# shellcheck disable=SC2016  # ${...} abaixo é template literal do JavaScript
read -r NAME VERSION < <(node -e '
  const m = require("./chrome/manifest.json");
  process.stdout.write(`${require("./chrome/package.json").name} ${m.version}\n`);
')
PKG_VERSION="$(node -p 'require("./chrome/package.json").version')"
[[ "$VERSION" == "$PKG_VERSION" ]] ||
  die "Versões diferentes: chrome/manifest.json=$VERSION, chrome/package.json=$PKG_VERSION. Ajuste antes do build."
# O Chrome só aceita de 1 a 4 números separados por ponto (sem letras).
[[ "$VERSION" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]] || die "Versão $VERSION inválida para o Chrome (use só números, ex.: 1.2.3)."
ok "Versão $VERSION"

# ---------- verificação de sintaxe ----------
step "Verificando sintaxe dos scripts"
while IFS= read -r -d '' f; do
  node --check "$f" || die "Erro de sintaxe em $f"
done < <(find "$COMMON/src" "$COMMON/dashboard" "$BROWSER" -maxdepth 1 -name '*.js' -print0)
ok "Sintaxe OK"

# ---------- testes ----------
if (( RUN_TESTS )); then
  step "Rodando testes unitários"
  node --test --test-reporter=spec "common/tests/*.test.js" ||
    die "Testes falharam. Corrija antes do build (ou use --skip-tests)."
  ok "Testes passaram"
else
  warn "Testes pulados (--skip-tests)"
fi

# ---------- montagem ----------
# Só estes caminhos vão para o pacote: as pastas comuns de common/ e o manifest.json
# e o service-worker.js de chrome/, todos na raiz do pacote.
COMMON_FILES=(_locales src dashboard icons)
BROWSER_FILES=(manifest.json service-worker.js)

step "Montando o pacote numa pasta limpa"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/extensao"
mkdir -p "$STAGE"
for item in "${COMMON_FILES[@]}"; do
  [[ -e "$COMMON/$item" ]] || die "Arquivo esperado não encontrado: common/$item"
  cp -R "$COMMON/$item" "$STAGE/"
done
for item in "${BROWSER_FILES[@]}"; do
  [[ -e "$BROWSER/$item" ]] || die "Arquivo esperado não encontrado: chrome/$item"
  cp -R "$BROWSER/$item" "$STAGE/"
done
find "$STAGE" -name '.*' -exec rm -rf {} +
ok "$(find "$STAGE" -type f | wc -l | tr -d ' ') arquivos: ${BROWSER_FILES[*]} ${COMMON_FILES[*]}"

# ---------- verificações do manifesto (o Chrome não tem um "lint" oficial) ----------
step "Validando o manifesto para o Chrome"
node - "$STAGE" <<'NODE' || die "Manifesto inválido para o Chrome (veja acima)."
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const errors = [];
const exists = (p) => fs.existsSync(path.join(dir, p));
if (m.manifest_version !== 3) errors.push("manifest_version precisa ser 3");
if (m.browser_specific_settings) errors.push("browser_specific_settings é só do Firefox");
if (!m.background || !m.background.service_worker) errors.push("background.service_worker é obrigatório no Chrome");
if (m.background && m.background.scripts) errors.push("background.scripts não existe no Chrome (use service_worker)");
// Arquivos citados no manifesto.
const files = [
  m.background && m.background.service_worker,
  ...Object.values(m.icons || {}),
  ...Object.values((m.action && m.action.default_icon) || {}),
  ...(m.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
].filter(Boolean);
for (const f of files) if (!exists(f)) errors.push(`arquivo não encontrado no pacote: ${f}`);
for (const f of Object.values((m.action && m.action.default_icon) || {}))
  if (/\.svg$/i.test(f)) errors.push(`o Chrome não aceita SVG em action.default_icon: ${f}`);
// Scripts importados pelo service worker.
const sw = m.background && m.background.service_worker;
if (sw && exists(sw)) {
  for (const [, f] of fs.readFileSync(path.join(dir, sw), "utf8").matchAll(/"([^"]+\.js)"/g))
    if (!exists(f)) errors.push(`service worker importa um arquivo que não está no pacote: ${f}`);
}
// Textos traduzidos: limites do Chrome Web Store (nome até 75, descrição até 132).
const key = (v) => (/^__MSG_(\w+)__$/.exec(v || "") || [])[1];
const locales = fs.readdirSync(path.join(dir, "_locales"));
if (!locales.includes(m.default_locale)) errors.push(`default_locale ${m.default_locale} não existe em _locales`);
for (const loc of locales) {
  const msgs = JSON.parse(fs.readFileSync(path.join(dir, "_locales", loc, "messages.json"), "utf8"));
  for (const [field, max] of [["name", 75], ["description", 132], ["short_name", 12]]) {
    const k = key(m[field]);
    if (!k) continue;
    const msg = msgs[k] && msgs[k].message;
    if (msg == null) errors.push(`${loc}: falta a mensagem ${k} (${field})`);
    else if ([...msg].length > max) errors.push(`${loc}: ${field} com ${[...msg].length} caracteres (máximo ${max})`);
  }
}
if (errors.length) {
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(`  ${locales.length} idiomas, ${files.length} arquivos citados, nada faltando`);
NODE
ok "Manifesto OK"

# ---------- varredura de segredos ----------
step "Procurando segredos no pacote"
if hits="$(grep -rIlE '(API_SECRET|JWT_SECRET|API_KEY|JWT_ISSUER|CLIENT_SECRET|REFRESH_TOKEN)[[:space:]]*[:=][[:space:]]*["'\''][^"'\'' ]{8,}|user:[0-9]+:[0-9]+|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$STAGE")"; then
  printf '%s\n' "$hits" | sed "s|^$STAGE/|  - |" >&2
  die "Possível credencial dentro do pacote (arquivos acima). Nada foi gerado."
fi
ok "Nenhuma credencial encontrada"

# ---------- teste de carga num Chromium (opcional) ----------
if (( CHECK )); then
  step "Carregando a extensão num Chromium de teste"
  node - "$STAGE" <<'NODE' || die "A extensão deu erro ao carregar no Chromium (veja acima)."
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  console.error("  Playwright não encontrado. Instale com: npm i -g playwright && npx playwright install chromium");
  process.exit(2);
}
const os = require("os");
const fs = require("fs");
const path = require("path");
(async () => {
  const dir = process.argv[2];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "watchroll-chrome-"));
  // Extensões só carregam no Chromium completo (o "headless shell" não aceita):
  // channel "chromium" usa o modo headless novo do navegador inteiro.
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  const errors = [];
  try {
    let [worker] = ctx.serviceWorkers();
    if (!worker) worker = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
    const id = new URL(worker.url()).host;
    worker.on("console", (m) => m.type() === "error" && errors.push("service worker: " + m.text()));
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("página: " + e.message));
    // Erros já tratados pela extensão começam com "[Watchroll]" (ex.: sem login ou sem
    // rede para a Crunchyroll no Chromium de teste): não contam como falha.
    page.on("console", (m) => m.type() === "error" && !/^\[Watchroll\]|Failed to load resource|net::/i.test(m.text()) && errors.push("página: " + m.text()));
    await page.goto(`chrome-extension://${id}/dashboard/dashboard.html`);
    await page.waitForTimeout(2500);
    const tabs = await page.$$eval("[role=tab]", (t) => t.length);
    if (!tabs) errors.push("a página da extensão não desenhou as abas");
    const ok = await worker.evaluate(() => typeof browser !== "undefined" && typeof CRChecker !== "undefined");
    if (!ok) errors.push("o service worker não carregou os scripts comuns");
    console.log(`  extensão ${id}: service worker ativo, página com ${tabs} abas`);
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  if (errors.length) {
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
})().catch((e) => {
  console.error("  " + (e && e.message ? e.message : e));
  process.exit(1);
});
NODE
  ok "Carregou sem erros no Chromium"
fi

# ---------- pacote ----------
step "Gerando pacote"
mkdir -p "$DIST"
ZIP="$DIST/$NAME-chrome-$VERSION.zip"
rm -f "$ZIP"
if command -v zip >/dev/null; then
  (cd "$STAGE" && zip -qrX "$ZIP" .)
else
  python3 - "$STAGE" "$ZIP" <<'PY' || die "Não consegui gerar o .zip (instale o zip ou o python3)."
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk(src):
        for f in sorted(files):
            full = os.path.join(base, f)
            z.write(full, os.path.relpath(full, src))
PY
fi
ok "Pacote: ${ZIP#"$ROOT"/} ($(du -h "$ZIP" | cut -f1))"

step "Pronto"
cat <<EOF
  Pacote: $ZIP

  Para testar: chrome://extensions → ative o "Modo do desenvolvedor"
               → descompacte o .zip numa pasta → "Carregar sem compactação" → escolha a pasta
  Para publicar: envie o .zip em https://chrome.google.com/webstore/devconsole
EOF
