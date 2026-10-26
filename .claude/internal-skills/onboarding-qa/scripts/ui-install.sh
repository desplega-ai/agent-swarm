#!/usr/bin/env bash
# Test 2 prep: a clean, tagged swarm on the QA box, installed the way the docs say.
#
#   ui-install.sh <run> [--reset] [install.sh args...]   (default args: --preset full --tunnel, as in the README and docs)
#
# 1. --reset first removes a previous install (compose down -v, tunnel, ~/agent-swarm).
# 2. Runs the one-shot installer as root: curl install.sh | bash -s -- <args>, log in ~/install.log.
# 3. Saves the printed /setup link (secrets.sh setup-url).
# 4. Tags telemetry: global config DESPLEGA_TELEMETRY_ENV=onboarding-qa, then restarts the stack
#    so the API and every agent boot with it.
# 5. Prints the version and the telemetry org id, and stores ORG= in run.env.
#
# ONBOARDING_QA_INSTALL_URL overrides the installer URL (for example a branch's raw install.sh).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
run="${1:?run id}"
shift
dir="/tmp/onboarding-qa-$run"
cfg="$dir/ssh_config"
[ -f "$cfg" ] || { echo "no ssh config at $cfg (box.sh up first)" >&2; exit 2; }
url="${ONBOARDING_QA_INSTALL_URL:-https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/install.sh}"

if [ "${1:-}" = "--reset" ]; then
  shift
  ssh -F "$cfg" box bash -s <<'REMOTE'
set -u
cd ~/agent-swarm 2>/dev/null && {
  [ -f .agent-swarm/tunnel.pid ] && { pkill -P "$(cat .agent-swarm/tunnel.pid)"; kill "$(cat .agent-swarm/tunnel.pid)"; } 2>/dev/null
  docker compose down -v --remove-orphans >/dev/null 2>&1
}
rm -rf ~/agent-swarm ~/install.log
echo "previous install removed"
REMOTE
fi
[ $# -gt 0 ] || set -- --preset full --tunnel

started=$(date +%s)
echo "installing with $url $* ($(TZ=Europe/Madrid date '+%H:%M:%S') BCN)"
set +e
ssh -F "$cfg" box "curl -fsSL $(printf '%q' "$url") | DESPLEGA_TELEMETRY_ENV=onboarding-qa bash -s -- $(printf '%q ' "$@") >~/install.log 2>&1"
status=$?
set -e
echo "installer exit $status after $(($(date +%s) - started))s. Log tail (key redacted):"
ssh -F "$cfg" box 'tail -n 15 ~/install.log' | sed -E 's/(apiKey=)[^&[:space:]]+/\1<redacted>/g; s/((API_KEY|apiKey)[=:] *)[^[:space:]]+/\1<redacted>/g'
[ "$status" -eq 0 ] || exit "$status"

bash "$here/secrets.sh" setup-url "$run"

bash "$here/box-api.sh" "$run" PUT /api/config \
  '{"scope":"global","key":"DESPLEGA_TELEMETRY_ENV","value":"onboarding-qa","description":"onboarding-qa run marker"}' |
  tail -1
ssh -F "$cfg" box 'cd ~/agent-swarm && docker compose restart >/dev/null 2>&1 && echo "stack restarted"'
for _ in $(seq 1 30); do
  bash "$here/box-api.sh" "$run" GET /health 2>/dev/null | grep -q 'HTTP 200' && break
  sleep 5
done

health="$(bash "$here/box-api.sh" "$run" GET /health | head -1)"
org="$(bash "$here/box-api.sh" "$run" GET '/api/config?scope=global&key=telemetry_org_id' |
  grep -oE '"value":"org_[A-Za-z0-9]+"' | grep -oE 'org_[A-Za-z0-9]+' | head -1 || true)"
grep -v '^ORG=' "$dir/run.env" >"$dir/run.env.tmp" || true
echo "ORG=$org" >>"$dir/run.env.tmp"
mv "$dir/run.env.tmp" "$dir/run.env"
echo "health: $health"
echo "telemetry org: ${org:-not found}"
echo "ready $(TZ=Europe/Madrid date '+%H:%M:%S') BCN, $(($(date +%s) - started))s after start"
