#!/bin/sh
set -eu
: "${SCRIPT_RUNNER_API_URL:?set SCRIPT_RUNNER_API_URL to the API URL}"
# Compose file secrets can preserve source permissions instead of Secret mode.
# Refuse a credential that native guests could read under the pinned sandbox uid.
if [ -n "${SCRIPT_RUNNER_TOKEN_FILE:-}" ] && \
  setpriv --reuid=65534 --regid=65534 --clear-groups \
    sh -c 'exec 3<"$1"' sh "$SCRIPT_RUNNER_TOKEN_FILE" 2>/dev/null; then
  echo "Runner token file must not be readable by sandbox uid 65534. Restrict the source file permissions." >&2
  exit 1
fi
# A new process must establish its own connection before it becomes ready.
rm -f /tmp/script-runner.ready
exec /usr/local/bin/agent-swarm-script-runner --api-url "$SCRIPT_RUNNER_API_URL" "$@"
