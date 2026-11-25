#!/bin/sh
set -eu
: "${SCRIPT_RUNNER_API_URL:?set SCRIPT_RUNNER_API_URL to the API URL}"
if ! setpriv --reuid=65534 --regid=65534 --clear-groups true; then
  echo "The runner requires permission to start sandbox processes as uid 65534." >&2
  exit 1
fi
# Compose file secrets can preserve source permissions instead of Secret mode.
# Refuse a credential that native guests could read under the pinned sandbox uid.
if [ -n "${SCRIPT_RUNNER_TOKEN_FILE:-}" ] && \
  setpriv --reuid=65534 --regid=65534 --clear-groups \
    sh -c 'exec 3<"$1"' sh "$SCRIPT_RUNNER_TOKEN_FILE" 2>/dev/null; then
  echo "Runner token file must not be readable by sandbox uid 65534. Restrict the source file permissions." >&2
  exit 1
fi
# A new process must establish its own connection before it becomes ready.
install -d -o root -g root -m 0700 /run/agent-swarm-script-runner
export SCRIPT_RUNNER_READY_FILE=/run/agent-swarm-script-runner/ready
rm -f "$SCRIPT_RUNNER_READY_FILE"
exec /usr/local/bin/agent-swarm-script-runner --api-url "$SCRIPT_RUNNER_API_URL" "$@"
