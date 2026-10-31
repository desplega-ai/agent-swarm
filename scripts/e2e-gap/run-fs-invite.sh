#!/usr/bin/env bash
# Runs the gap-fs-invite-pending scenario (#2478) against a throwaway local agent-fs daemon.
# Usage: AFS_REPO=/path/to/agent-fs scripts/e2e-gap/run-fs-invite.sh
set -euo pipefail
AFS_REPO=${AFS_REPO:-/workspace/personal/repos/agent-fs}
cd "$(dirname "$0")/../.."
for mode in url nourl; do
  home=$(mktemp -d); port=$(bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop()')
  app=""; [ "$mode" = url ] && app="https://app.example.test"
  (cd "$AFS_REPO" && exec env -i PATH="$PATH" HOME="$home" AGENT_FS_HOME="$home" AGENT_FS_STORAGE_PROVIDER=local \
     AGENT_FS_LOCAL_ROOT="$home/storage" EMBEDDING_PROVIDER=none SERVER_PORT="$port" SERVER_HOST=127.0.0.1 \
     AGENT_FS_RATE_LIMIT=0 ANONYMIZED_TELEMETRY=false ${app:+AGENT_FS_APP_URL="$app"} \
     bun packages/server/src/index.ts >"$home/daemon.log" 2>&1) &
  dpid=$!
  for _ in $(seq 60); do curl -sf "http://127.0.0.1:$port/health" >/dev/null && break; sleep 0.5; done
  echo "== mode=$mode (agent-fs $(curl -s "http://127.0.0.1:$port/health" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).version)'))"
  set +e
  GAP_AFS_URL="http://127.0.0.1:$port" GAP_AFS_MODE=$mode GAP_AFS_APP_URL="$app" \
    bun run e2e --only gap-fs-invite-pending --sut-env "AGENT_FS_API_URL=http://127.0.0.1:$port" --json "/tmp/gap-fs-invite-$mode.json" 2>&1 | grep -E "gap-fs-invite|PASS|FAIL|error|Error" | head -20
  rc=${PIPESTATUS[0]}
  set -e
  kill "$dpid" 2>/dev/null || true; pkill -P "$dpid" 2>/dev/null || true; rm -rf "$home"
  [ "$rc" -eq 0 ] || exit "$rc"
done
