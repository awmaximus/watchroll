#!/usr/bin/env bash
# Muda a versão das extensões do Firefox e do Chrome de uma vez.
#
# A versão fica em cinco lugares, que precisam ser iguais:
#   firefox/manifest.json, firefox/package.json,
#   chrome/manifest.json, chrome/package.json
#   e a linha "(current: X.Y.Z)" do README.md
#
# Regra das versões: último número ímpar = teste (unlisted); par = publicada (listed).
#
# Uso:
#   ./set-version.sh 1.4.10     muda para 1.4.10
#   ./set-version.sh            mostra a versão atual de cada arquivo
#   ./set-version.sh --help

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JSON_FILES=(firefox/manifest.json firefox/package.json chrome/manifest.json chrome/package.json)
README="README.md"

if [[ -t 1 ]]; then
  BOLD=$'\e[1m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi
ok()   { printf '%s✔ %s%s\n' "$GREEN" "$1" "$RESET"; }
warn() { printf '%s! %s%s\n' "$YELLOW" "$1" "$RESET" >&2; }
die()  { printf '%s✘ %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# Versão de um JSON: o primeiro "version": "..." (no topo do arquivo).
json_version() {
  sed -n -E 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$ROOT/$1" | head -n 1
}
readme_version() {
  sed -n -E 's/.*\(current: ([0-9]+\.[0-9]+\.[0-9]+)\).*/\1/p' "$ROOT/$README" | head -n 1
}

show() {
  local f v first="" same=1
  for f in "${JSON_FILES[@]}"; do
    v="$(json_version "$f")"
    printf '  %-24s %s\n' "$f" "${v:-?}"
    [[ -z "$first" ]] && first="$v"
    [[ "$v" == "$first" ]] || same=0
  done
  v="$(readme_version)"
  printf '  %-24s %s\n' "$README" "${v:-?}"
  [[ "$v" == "$first" ]] || same=0
  if (( same )); then ok "Todos em $first"; else warn "As versões estão diferentes"; fi
}

# Troca no arquivo (funciona no Linux e no macOS: sem sed -i nem endereço 0,/re/).
replace() {
  local file="$ROOT/$1" expr="$2" tmp
  tmp="$(mktemp)"
  sed -E "$expr" "$file" >"$tmp"
  cat "$tmp" >"$file" # mantém permissões e o arquivo (não troca o inode)
  rm -f "$tmp"
}

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  "") printf '%sVersões atuais%s\n' "$BOLD" "$RESET"; show; exit 0 ;;
esac

NEW="$1"
# Firefox e Chrome aceitam até 4 números de 0 a 65535; aqui usamos sempre 3.
[[ "$NEW" =~ ^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$ ]] ||
  die "Versão inválida: '$NEW' (use X.Y.Z, por exemplo 1.4.10)"
for n in "${BASH_REMATCH[@]:1}"; do
  (( n <= 65535 )) || die "Cada número da versão vai até 65535"
done

OLD="$(json_version firefox/manifest.json)"
for f in "${JSON_FILES[@]}" "$README"; do [[ -f "$ROOT/$f" ]] || die "Não achei $f"; done

for f in "${JSON_FILES[@]}"; do
  # Só a primeira linha "version" (a do topo); "manifest_version" não casa.
  tmp="$(mktemp)"
  awk -v v="$NEW" '
    !done && /^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"/ {
      sub(/"version"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"version\": \"" v "\"")
      done = 1
    }
    { print }
  ' "$ROOT/$f" >"$tmp"
  cat "$tmp" >"$ROOT/$f"
  rm -f "$tmp"
done
replace "$README" "s/\(current: [0-9]+\.[0-9]+\.[0-9]+\)/(current: $NEW)/"

# Confere o resultado.
for f in "${JSON_FILES[@]}"; do
  [[ "$(json_version "$f")" == "$NEW" ]] || die "Não consegui mudar a versão em $f"
done
[[ "$(readme_version)" == "$NEW" ]] || die "Não consegui mudar a versão no $README (linha \"(current: X.Y.Z)\")"
if command -v node >/dev/null 2>&1; then
  for f in "${JSON_FILES[@]}"; do
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$ROOT/$f" ||
      die "$f ficou com JSON inválido"
  done
fi

ok "Versão ${OLD:-?} → $NEW em ${#JSON_FILES[@]} arquivos JSON e no $README"
if (( ${NEW##*.} % 2 )); then
  ok "Ímpar: canal unlisted (teste)"
else
  ok "Par: canal listed (publicada na loja)"
fi
printf '\nPara fazer o commit:\n  git add -A && git commit -m "Versão %s"\n' "$NEW"
