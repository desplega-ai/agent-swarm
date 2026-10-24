#!/usr/bin/env bash
# Call the swarm API on a QA box from the box itself, with the install's own key.
#
#   box-api.sh <run> <METHOD> <path> [json-body]
#
# Finds the API key in the first .env under /root, /home, /opt or /srv that sets
# AGENT_SWARM_API_KEY or API_KEY, and the host port mapped to the API container's
# 3013 (default 3013). Prints only the response body and the HTTP status. The key
# never leaves the box.
set -euo pipefail

run="${1:?run id}" method="${2:?METHOD}" path="${3:?path}" body="${4:-}"
cfg="/tmp/onboarding-qa-$run/ssh_config"
[ -f "$cfg" ] || { echo "no ssh config at $cfg (box.sh up first)" >&2; exit 2; }

ssh -F "$cfg" box bash -s -- "$(printf '%q' "$method")" "$(printf '%q' "$path")" "$(printf '%q' "$body")" <<'REMOTE'
set -euo pipefail
method="$1" path="$2" body="$3"
key=""
while read -r f; do
  key="$(grep -E '^(AGENT_SWARM_API_KEY|API_KEY)=' "$f" | head -1 | cut -d= -f2- | tr -d "\"'" || true)"
  [ -n "$key" ] && break
done < <(find /root /home /opt /srv -maxdepth 4 -name .env -not -path '*/node_modules/*' 2>/dev/null)
[ -n "$key" ] || { echo "no API key found in any .env on the box" >&2; exit 3; }
port="$(docker ps --format '{{.Image}} {{.Ports}}' 2>/dev/null | grep -E 'desplega-ai/agent-swarm:' | grep -oE '[0-9]+->3013' | head -1 | cut -d- -f1 || true)"
args=(-sS -o /tmp/box-api.out -w '%{http_code}' -X "$method" -H "Authorization: Bearer $key")
[ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data "$body")
code="$(curl "${args[@]}" "http://127.0.0.1:${port:-3013}$path")"
cat /tmp/box-api.out; echo; echo "HTTP $code"
rm -f /tmp/box-api.out
REMOTE
