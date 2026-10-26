#!/usr/bin/env bash
# Drive the "user's coding agent" (headless Claude Code) on a QA box, one turn at a time.
#
#   inner-turn.sh setup <run> <root|alex>         install Claude Code for that user, upload the turn runner
#   inner-turn.sh send <run> <message-file>       start the next turn on the box (detached, survives SSH drops)
#   inner-turn.sh wait <run> [seconds]            wait for the running turn (default 540), then fetch + summarize it
#   inner-turn.sh turn <run> <message-file> [s]   send + wait
#
# Turn 1 creates the session; later turns --resume it. The box user needs
# ~/qa-secrets/CLAUDE_CODE_OAUTH_TOKEN (secrets.sh push). Transcripts land in
# /tmp/onboarding-qa-<run>/turns/<n>.jsonl, summaries in <n>.summary.md.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)"
ENV_FILE="${ONBOARDING_QA_ENV_FILE:-$(dirname "$common")/.env}"

dir_of() {
  local dir="/tmp/onboarding-qa-$1"
  [ -f "$dir/ssh_config" ] || { echo "no ssh config at $dir (box.sh up first)" >&2; exit 2; }
  echo "$dir"
}

host_of() {
  local dir="$1"
  [ -f "$dir/inner.env" ] || { echo "run inner-turn.sh setup first" >&2; exit 2; }
  grep -E '^HOST=' "$dir/inner.env" | cut -d= -f2
}

cmd_setup() {
  local run="$1" who="$2" dir host
  dir="$(dir_of "$run")"
  case "$who" in root) host=box ;; alex) host=box-user ;; *) echo "user must be root or alex" >&2; exit 2 ;; esac
  ssh -F "$dir/ssh_config" "$host" 'command -v claude >/dev/null || [ -x ~/.local/bin/claude ] || curl -fsSL https://claude.ai/install.sh | bash >/dev/null'
  ssh -F "$dir/ssh_config" "$host" 'mkdir -p ~/.qa/turns && cat /proc/sys/kernel/random/uuid > ~/.qa/session-id && cat > ~/.qa/turn.sh && chmod +x ~/.qa/turn.sh' <<'RUNNER'
#!/usr/bin/env bash
# One headless turn. Exit code lands in turns/<n>.exit when the turn ends.
set -uo pipefail
n="$1"
q="$HOME/.qa"
export PATH="$HOME/.local/bin:$PATH"
CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/qa-secrets/CLAUDE_CODE_OAUTH_TOKEN")"
export CLAUDE_CODE_OAUTH_TOKEN
# Tags anything the agent runs from this shell (bunx onboard, CLI calls) as QA telemetry.
export DESPLEGA_TELEMETRY_ENV=onboarding-qa
# Claude Code refuses --dangerously-skip-permissions as root unless it is told it runs in a sandbox.
if [ "$(id -u)" = 0 ]; then export IS_SANDBOX=1; fi
sid="$(cat "$q/session-id")"
if [ "$n" = 1 ]; then session=(--session-id "$sid"); else session=(--resume "$sid"); fi
cd "$HOME"
date +%s >"$q/turns/$n.start"
claude -p --output-format stream-json --verbose --dangerously-skip-permissions "${session[@]}" \
  <"$q/turns/$n.in" >"$q/turns/$n.jsonl" 2>"$q/turns/$n.err"
echo $? >"$q/turns/$n.exit"
RUNNER
  printf 'HOST=%s\nTURN=0\n' "$host" >"$dir/inner.env"
  echo "inner agent ready for $who on box ($(ssh -F "$dir/ssh_config" "$host" 'PATH="$HOME/.local/bin:$PATH" claude --version'))"
}

cmd_send() {
  local run="$1" msg="$2" dir host n
  dir="$(dir_of "$run")"
  host="$(host_of "$dir")"
  [ -f "$msg" ] || { echo "no message file $msg" >&2; exit 2; }
  n=$(($(grep -E '^TURN=' "$dir/inner.env" | cut -d= -f2) + 1))
  if [ "$n" -gt 1 ] && ! ssh -F "$dir/ssh_config" "$host" "test -f ~/.qa/turns/$((n - 1)).exit"; then
    echo "turn $((n - 1)) is still running: inner-turn.sh wait $run" >&2
    exit 1
  fi
  ssh -F "$dir/ssh_config" "$host" "cat > ~/.qa/turns/$n.in" <"$msg"
  cp "$msg" "$dir/turns/$n.in"
  ssh -F "$dir/ssh_config" "$host" "setsid nohup ~/.qa/turn.sh $n >/dev/null 2>&1 </dev/null &"
  printf 'HOST=%s\nTURN=%s\n' "$host" "$n" >"$dir/inner.env"
  echo "turn $n started $(TZ=Europe/Madrid date '+%H:%M:%S') BCN"
}

cmd_wait() {
  local run="$1" timeout="${2:-540}" dir host n waited=0
  dir="$(dir_of "$run")"
  host="$(host_of "$dir")"
  n="$(grep -E '^TURN=' "$dir/inner.env" | cut -d= -f2)"
  [ "$n" -gt 0 ] || { echo "no turn sent yet" >&2; exit 2; }
  until ssh -F "$dir/ssh_config" "$host" "test -f ~/.qa/turns/$n.exit"; do
    if [ "$waited" -ge "$timeout" ]; then
      echo "turn $n still running after ${waited}s. Call: inner-turn.sh wait $run"
      exit 3
    fi
    sleep 15
    waited=$((waited + 15))
  done
  scp -q -F "$dir/ssh_config" "$host:.qa/turns/$n.jsonl" "$host:.qa/turns/$n.err" "$host:.qa/turns/$n.exit" "$dir/turns/"
  # Secrets the install generated (API key, encryption key) are scrubbed too.
  ssh -F "$dir/ssh_config" box \
    "find /root /home /opt /srv -maxdepth 4 -name .env -not -path '*/node_modules/*' -exec cat {} + 2>/dev/null" \
    >"$dir/box.env" || true
  chmod 600 "$dir/box.env"
  bun "$here/summarize-turn.ts" "$dir/turns/$n.jsonl" --env "$ENV_FILE" --env "$dir/box.env"
}

case "${1:-}" in
  setup) cmd_setup "${2:?run id}" "${3:?root|alex}" ;;
  send) cmd_send "${2:?run id}" "${3:?message file}" ;;
  wait) cmd_wait "${2:?run id}" "${3:-}" ;;
  turn) cmd_send "${2:?run id}" "${3:?message file}" && cmd_wait "$2" "${4:-}" ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
