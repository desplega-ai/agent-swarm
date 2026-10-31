#!/usr/bin/env bash
# Runs one e2e scenario against a throwaway local agent-fs daemon (local storage, no embeddings).
# Usage: AFS_REPO=/path/to/agent-fs scripts/e2e-gap/with-afs.sh <scenario> [run.ts args...]
# Exports GAP_AFS_URL to the scenario and passes AGENT_FS_API_URL to the SUT.
set -euo pipefail
AFS_REPO=${AFS_REPO:-/workspace/personal/repos/agent-fs}
scenario=$1; shift
cd "$(dirname "$0")/../.."
home=$(mktemp -d)
port=$(bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop()')
(cd "$AFS_REPO" && exec env -i PATH="$PATH" HOME="$home" AGENT_FS_HOME="$home" AGENT_FS_STORAGE_PROVIDER=local \
   AGENT_FS_LOCAL_ROOT="$home/storage" EMBEDDING_PROVIDER=none SERVER_PORT="$port" SERVER_HOST=127.0.0.1 \
   AGENT_FS_RATE_LIMIT=0 ANONYMIZED_TELEMETRY=false \
   bun packages/server/src/index.ts >"$home/daemon.log" 2>&1) &
dpid=$!
trap 'kill "$dpid" 2>/dev/null || true; pkill -P "$dpid" 2>/dev/null || true; rm -rf "$home"' EXIT
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$port/health" >/dev/null && break; sleep 0.5; done
GAP_AFS_URL="http://127.0.0.1:$port" bun scripts/e2e/run.ts --only "$scenario" \
  --sut-env "AGENT_FS_API_URL=http://127.0.0.1:$port" "$@"
