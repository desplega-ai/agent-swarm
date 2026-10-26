#!/usr/bin/env bash
# Move credentials without printing them.
#
#   secrets.sh push <run> <root|alex> KEY [KEY...]  copy KEY values from the env file to ~/qa-secrets/KEY on the box
#   secrets.sh push-env <run> <box-file> KEY [KEY...] set KEY=value lines in a dotenv file on the box (as root)
#   secrets.sh fill <ref> KEY                       type the KEY value into a browser field (agent-browser fill)
#   secrets.sh setup-url <run>                      copy the dashboard /setup link from ~/install.log on the box
#   secrets.sh open-setup <run>                     open that link in agent-browser
#
# The env file is ONBOARDING_QA_ENV_FILE, default: the main checkout's .env (works from worktrees).
# Output names keys and lengths only. The /setup link carries the box API key, so it stays in
# /tmp/onboarding-qa-<run>/setup-url (mode 600) and is printed with the key redacted.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)"
ENV_FILE="${ONBOARDING_QA_ENV_FILE:-$(dirname "$common")/.env}"

value_of() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -E 's/^["'"'"']//; s/["'"'"']$//')"
  [ -n "$v" ] || { echo "$1 is not set in $ENV_FILE" >&2; return 1; }
  printf '%s' "$v"
}

redact_key() { sed -E 's/(apiKey=)[^&[:space:]]+/\1<redacted>/g'; }

cmd_push() {
  local run="$1" who="$2" host cfg key
  shift 2
  cfg="/tmp/onboarding-qa-$run/ssh_config"
  case "$who" in root) host=box ;; alex) host=box-user ;; *) echo "user must be root or alex" >&2; exit 2 ;; esac
  ssh -F "$cfg" "$host" 'mkdir -p ~/qa-secrets && chmod 700 ~/qa-secrets'
  for key in "$@"; do
    [[ "$key" =~ ^[A-Z0-9_]+$ ]] || { echo "bad key name: $key" >&2; exit 2; }
    value_of "$key" | ssh -F "$cfg" "$host" "umask 077 && cat > ~/qa-secrets/$key"
    echo "pushed $key to $who@box:~/qa-secrets/$key ($(value_of "$key" | wc -c | tr -d ' ') chars)"
  done
}

cmd_push_env() {
  local run="$1" file="$2" cfg key
  shift 2
  cfg="/tmp/onboarding-qa-$run/ssh_config"
  [[ "$file" =~ ^[A-Za-z0-9_./~-]+$ ]] || { echo "bad box file path: $file" >&2; exit 2; }
  for key in "$@"; do
    [[ "$key" =~ ^[A-Z0-9_]+$ ]] || { echo "bad key name: $key" >&2; exit 2; }
    # The value travels on stdin and replaces any earlier KEY= line.
    value_of "$key" | ssh -F "$cfg" box "umask 077 && v=\$(cat) && f=$file && touch \$f &&
      { grep -v '^$key=' \$f || true; printf '%s=%s\\n' $key \"\$v\"; } > \$f.tmp && mv \$f.tmp \$f"
    echo "set $key in root@box:$file ($(value_of "$key" | wc -c | tr -d ' ') chars)"
  done
}

cmd_fill() {
  local ref="$1" key="$2"
  agent-browser fill "$ref" "$(value_of "$key")" >/dev/null
  # A real paste commits at once; fill does not fire paste. Blurring the field
  # commits like a user who clicks elsewhere (Tab alone can stay inside the field group).
  agent-browser eval 'document.activeElement && document.activeElement.blur()' >/dev/null
  echo "filled $ref with $key ($(value_of "$key" | wc -c | tr -d ' ') chars), then blurred"
}

cmd_setup_url() {
  local run="$1" dir url
  dir="/tmp/onboarding-qa-$run"
  url="$(ssh -F "$dir/ssh_config" box 'cat ~/install.log' | sed -E $'s/\x1b\\[[0-9;]*m//g' |
    grep -oE 'https://[^[:space:]]+/setup\?apiUrl=[^[:space:]]+' | tail -1 || true)"
  [ -n "$url" ] || { echo "no /setup link in ~/install.log on the box" >&2; exit 1; }
  (umask 077 && printf '%s\n' "$url" >"$dir/setup-url")
  echo "saved $dir/setup-url: $(redact_key <<<"$url")"
}

cmd_open_setup() {
  local file="/tmp/onboarding-qa-$1/setup-url"
  [ -f "$file" ] || { echo "run secrets.sh setup-url $1 first" >&2; exit 2; }
  agent-browser open "$(cat "$file")" 2>&1 | redact_key
}

case "${1:-}" in
  push) [ $# -ge 4 ] || { sed -n '2,13p' "$0"; exit 2; }; shift; cmd_push "$@" ;;
  push-env) [ $# -ge 4 ] || { sed -n '2,13p' "$0"; exit 2; }; shift; cmd_push_env "$@" ;;
  fill) [ $# -eq 3 ] || { sed -n '2,13p' "$0"; exit 2; }; cmd_fill "$2" "$3" ;;
  setup-url) cmd_setup_url "${2:?run id}" ;;
  open-setup) cmd_open_setup "${2:?run id}" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
