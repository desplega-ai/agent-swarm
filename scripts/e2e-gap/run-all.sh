#!/usr/bin/env bash
# Runs every gap scenario that works on a clean Linux box with Docker, bun and outbound network.
# Usage (from the repo root, after `bun install`):
#   AFS_REPO=/path/to/agent-fs scripts/e2e-gap/run-all.sh [results-dir]
# Needs the agent-fs repo checked out and `bun install`ed at $AFS_REPO. Prints one PASS/FAIL line per leg.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=${1:-/tmp/e2e-gap-results}; mkdir -p "$OUT"
export AFS_REPO=${AFS_REPO:-$HOME/agent-fs}
export GAP_TMP=${GAP_TMP:-$HOME/gap-tmp}; mkdir -p "$GAP_TMP"
rc_all=0
leg() { # name, command...
  local name=$1; shift
  if "$@" >"$OUT/$name.log" 2>&1; then echo "PASS $name"; else echo "FAIL $name (rc=$?)"; rc_all=1; fi
}

# slack-mock: the local patch adds dropSocketBeforeAck and file attachments (agent-swarm PRs #2490, #2561).
if ! grep -q dropSocketBeforeAck node_modules/@desplega.ai/slack-mock/dist/*.js 2>/dev/null; then
  (cd node_modules/@desplega.ai/slack-mock && git apply --directory=. "$OLDPWD/scripts/e2e-gap/slack-mock-gap.patch") || echo "slack-mock patch did not apply" >&2
fi

# Plain scenarios, one SUT.
leg plain bun scripts/e2e/run.ts --only gap-pool-keys,gap-schedule-session-visibility,gap-workflow-run-finished --json "$OUT/plain.json"
leg steer-hooks bun scripts/e2e/run.ts --only gap-steer-hooks --sut-env EXTENSION_ALLOW_INLINE_INSTALL=true --sut-env STEERING_ENABLED=true
HB="--only gap-heartbeat-runner-probe --sut-env HEARTBEAT_CHECKLIST_DISABLE=false --sut-env HEARTBEAT_CHECKLIST_INTERVAL_MS=3000 --sut-env HEARTBEAT_CHECKLIST_GATE_SCRIPT=gap-quiet-gate --sut-env HEARTBEAT_CHECKLIST_GATE_MODE=enforce"
leg heartbeat-healthy env GAP_RUNNER=healthy bun scripts/e2e/run.ts $HB
leg heartbeat-unhealthy env GAP_RUNNER=unhealthy bun scripts/e2e/run.ts $HB --sut-env SCRIPT_EXECUTOR=gap-broken
leg codex-slot-error bun scripts/e2e/run.ts --only gap-codex-slot-auth-error
leg embedding-space bun scripts/e2e-gap/embedding-stub.ts gap-embedding-space
leg comb-requester scripts/e2e-gap/with-afs.sh gap-comb-requester
leg fs-invite scripts/e2e-gap/run-fs-invite.sh

# Slack (slack-mock).
leg slack bun scripts/e2e/run.ts --only gap-slack-leave,gap-slack-wake-any,gap-slack-icon,gap-slack-inbound,gap-slack-ack-drop
leg slack-reply-gate bun scripts/e2e/run.ts --only gap-slack-reply-gate --sut-env ADDITIVE_SLACK=true --sut-env ADDITIVE_SLACK_BUFFER_MS=1500

# Docker runtime pool cache (#2577).
printf 'FROM alpine\nCMD ["sleep","3600"]\n' | docker build -q -t e2e-gap-sleeper:1 - >/dev/null 2>&1 || true
leg pool-cache bun scripts/e2e/run.ts --only gap-runtime-pool-cache --sut-env RUNTIME_POOLS_ENABLED=true --sut-env MULTI_RUNTIME_ENABLED=true

# agent-fs scripts (agent-fs PRs 124, 126, 129, 133, 136).
for t in t136 t133 t124-126-129; do leg "agent-fs-$t" bun scripts/e2e-gap/agent-fs/$t.ts; done
exit $rc_all
