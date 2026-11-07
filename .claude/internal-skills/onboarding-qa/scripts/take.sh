#!/usr/bin/env bash
# Screen takes for the videos repo (templates/onboarding), in this shell's AGENT_BROWSER_SESSION.
#
#   take.sh open <url> [w h]        fresh browser at 2x, viewport w x h (default 1440 900), light mode on the dashboard, open url
#   take.sh open-setup <run> [w h]  same, then the saved /setup link (secrets.sh open-setup: the key is never printed)
#   take.sh start <clip> [--url-contains <text>]  record the tab into <raw>/<clip>/ (capture.mp4 + capture.json), background
#   take.sh mark <label>            a mark in capture.json (window.__onbvidMark); the template reads them
#   take.sh type "<text>" [--delay ms]  key events, one per character. Visible text only: keys go in with secrets.sh fill
#   take.sh enter                   the Enter key
#   take.sh stop <clip>             end the recording, write blips.json, list the outputs
#   take.sh scan <clip> [fps]       OCR the capture (tesseract) for apikey= and 24+ hex runs: prints seconds only
#
# Scripts come from the videos repo: VIDEO_SWARM_REPO (default ~/Documents/videos/swarm) scripts/screencast.ts,
# scripts/cdp-type.ts and scripts/blips.ts. Clips land in ONBOARDING_QA_RAW_DIR (default
# $VIDEO_SWARM_REPO/assets/onboarding/raw, gitignored there). mask.json and link.json are written by hand.
# Their shape is read by ensureClip() in $VIDEO_SWARM_REPO/templates/onboarding/src/index.ts (Box in src/track.ts):
#   mask.json  [{ "from": <anchor>, "to": <anchor>, "style": "dots" | "blur" | "skip", "boxes": [{ "x", "y", "w", "h" }] }]
#              anchor = source seconds or "mark:<label>"; "to" and "style" (default dots) are optional; "skip" has no
#              boxes and hides those source seconds from the edit. Boxes are CSS px (screenshot px / 2 at 2x).
#   link.json  { "x", "y", "w", "h" }: the printed /setup link, CSS px. The template adds a cursor click on it.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
REPO="${VIDEO_SWARM_REPO:-$HOME/Documents/videos/swarm}"
RAW="${ONBOARDING_QA_RAW_DIR:-$REPO/assets/onboarding/raw}"
DASHBOARD_HOST="app.agent-swarm.dev"
# 2x frames: every command that may launch the browser carries the flag (launch() passes it too).
export AGENT_BROWSER_ARGS="${AGENT_BROWSER_ARGS:---force-device-scale-factor=2}"

usage() { sed -n '2,11p' "$0"; exit 2; }
bcn() { TZ=Europe/Madrid date '+%H:%M:%S'; }
check_clip() { [[ "${1:-}" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || { echo "bad clip name: '${1:-}'" >&2; exit 2; }; }
need() {
  [ -n "${AGENT_BROWSER_SESSION:-}" ] || { echo "set AGENT_BROWSER_SESSION first (one browser per take)" >&2; exit 2; }
  [ -f "$REPO/scripts/screencast.ts" ] || { echo "no videos repo at $REPO (set VIDEO_SWARM_REPO)" >&2; exit 2; }
}

launch() {
  local w="${1:-1440}" h="${2:-900}"
  [[ "$w$h" =~ ^[0-9]+$ ]] || { echo "viewport must be two integers (got '$w' '$h')" >&2; exit 2; }
  # A fresh browser each time: the scale flag only applies at launch (headless Chrome sends CSS-pixel
  # frames otherwise), and the hosted dashboard keeps the last connection in localStorage.
  agent-browser close >/dev/null 2>&1 || true
  # The daemon is still going down right after close: the first command after it can get an empty reply.
  local i dpr
  for i in 1 2 3 4 5 6; do
    agent-browser --args "$AGENT_BROWSER_ARGS" open about:blank >/dev/null 2>&1 && break
    [ "$i" -lt 6 ] || { echo "agent-browser could not launch session $AGENT_BROWSER_SESSION" >&2; exit 1; }
    sleep 1
  done
  agent-browser set viewport "$w" "$h" 2 >/dev/null
  dpr="$(agent-browser eval "devicePixelRatio" 2>/dev/null | tail -1 | tr -d '[:space:]')"
  [ "$dpr" = 2 ] || { echo "devicePixelRatio is '$dpr', not 2: the browser did not launch with the scale flag" >&2; exit 1; }
}

light_mode() {
  # The dashboard reads its theme from localStorage on load: set it on the origin before the link opens.
  agent-browser open "https://$DASHBOARD_HOST/" >/dev/null
  agent-browser eval "localStorage.setItem('agent-swarm-mode','light')" >/dev/null
}

cmd_open() {
  local url="$1"
  launch "${2:-}" "${3:-}"
  [[ "$url" == "https://$DASHBOARD_HOST/"* ]] && light_mode
  agent-browser open "$url" >/dev/null
  echo "open ${url%%\?*} at ${2:-1440}x${3:-900} @2x in session $AGENT_BROWSER_SESSION ($(bcn) BCN)"
}

cmd_open_setup() {
  local run="$1"
  [ -f "/tmp/onboarding-qa-$run/setup-url" ] || { echo "run secrets.sh setup-url $run first (it reads the printed link from ~/install.log on the box, which the ttyd shell writes)" >&2; exit 2; }
  launch "${2:-}" "${3:-}"
  light_mode
  bash "$here/secrets.sh" open-setup "$run"
  echo "open /setup at ${2:-1440}x${3:-900} @2x, light mode, in session $AGENT_BROWSER_SESSION ($(bcn) BCN)"
}

cmd_start() {
  local clip="$1" out log pid
  shift
  out="$RAW/$clip"
  log="$out/screencast.log"
  [ ! -f "$out/capture.mp4" ] || { echo "$out/capture.mp4 exists: move it or pick another clip name" >&2; exit 1; }
  mkdir -p "$out"
  rm -f "$out/STOP"
  nohup bun "$REPO/scripts/screencast.ts" --out "$out" "$@" >"$log" 2>&1 </dev/null &
  pid=$!
  echo "$pid" >"$out/screencast.pid"
  for _ in $(seq 1 30); do
    grep -q '^recording' "$log" 2>/dev/null && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  cat "$log"
  grep -q '^recording' "$log" || { rm -f "$out/screencast.pid"; echo "screencast did not start" >&2; exit 1; }
  echo "recording $clip since $(bcn) BCN (pid $pid). Marks: take.sh mark <label>. End: take.sh stop $clip"
}

cmd_mark() {
  [[ "${1:-}" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || { echo "bad mark label: '${1:-}'" >&2; exit 2; }
  agent-browser eval "window.__onbvidMark('$1')" >/dev/null
  echo "mark $1 $(bcn) BCN"
}

cmd_stop() {
  local clip="$1" out pid
  out="$RAW/$clip"
  pid="$(cat "$out/screencast.pid" 2>/dev/null || true)"
  if ! { [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; }; then echo "no recording running for $clip" >&2; exit 1; fi
  touch "$out/STOP"
  for _ in $(seq 1 120); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -0 "$pid" 2>/dev/null && { echo "screencast still running (pid $pid), see $out/screencast.log" >&2; exit 1; }
  rm -f "$out/screencast.pid"
  tail -1 "$out/screencast.log"
  bun "$REPO/scripts/blips.ts" "$out"
  echo "$out ($(bcn) BCN):"
  du -h "$out/capture.mp4" | awk '{print "  capture.mp4\t" $1}'
  jq -r '"  capture.json\t\((.durationSec * 10 | round) / 10) s, \(.events | length) events, \(.viewport.w)x\(.viewport.h) @\(.viewport.dpr)x, marks: \([.events[] | select(.type == "mark") | .label] | join(" "))"' "$out/capture.json"
  echo "  next: take.sh scan $clip, then mask.json / link.json by hand where the take shows a secret or the printed link"
}

cmd_scan() {
  local clip="$1" fps="${2:-1}" out tmp n=0 hits=0 f first=-1 last=-1
  out="$RAW/$clip"
  [ -f "$out/capture.mp4" ] || { echo "no $out/capture.mp4" >&2; exit 1; }
  [[ "$fps" =~ ^[0-9]+$ ]] || { echo "fps must be an integer" >&2; exit 2; }
  command -v tesseract >/dev/null || { echo "tesseract is not installed (brew install tesseract)" >&2; exit 2; }
  # Not under /tmp: Leptonica rewrites a leading /tmp to $TMPDIR on macOS, and tesseract then reports
  # "image file not found" for every frame. The OCR also runs on a relative path from inside the dir.
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/onboarding-qa-scan.XXXXXX")"
  ffmpeg -loglevel error -i "$out/capture.mp4" -vf "fps=$fps" "$tmp/f%06d.png"
  local text read_any=0
  # Consecutive hit frames print as one range: "at 217.0s to 356.0s".
  flush() {
    [ "$first" -ge 0 ] || return 0
    if [ "$first" -eq "$last" ]; then
      awk -v a="$first" -v fps="$fps" 'BEGIN { printf "secret-like text at %.1fs\n", (a - 1) / fps }'
    else
      awk -v a="$first" -v b="$last" -v fps="$fps" 'BEGIN { printf "secret-like text at %.1fs to %.1fs (%d frames)\n", (a - 1) / fps, (b - 1) / fps, b - a + 1 }'
    fi
    first=-1 last=-1
  }
  for f in "$tmp"/f*.png; do
    n=$((n + 1))
    # OCR first, grep second: `tesseract | grep -q` under pipefail fails on a match (grep exits early,
    # tesseract dies with SIGPIPE), so every hit read as a miss (2026-10-27).
    text="$(cd "$tmp" && tesseract "$(basename "$f")" - 2>"$tmp/err" || true)"
    if grep -qE 'not found|fopenReadStream' "$tmp/err"; then
      echo "tesseract could not open frame $n: $(tail -1 "$tmp/err")" >&2; rm -rf "$tmp"; exit 1
    fi
    [ -z "$text" ] || read_any=1
    if grep -qiE 'apikey=|[0-9a-f]{24,}' <<<"$text"; then
      hits=$((hits + 1))
      if [ "$last" -eq $((n - 1)) ]; then last=$n; else flush; first=$n; last=$n; fi
    fi
  done
  flush
  rm -rf "$tmp"
  [ "$read_any" -eq 1 ] || { echo "tesseract read no text in any of the $n frames: the scan proves nothing" >&2; exit 1; }
  echo "$hits of $n frames hit (apikey= or a 24+ hex run, $fps frame/s). Cover every hit in $out/mask.json before the clip is used"
}

case "${1:-}" in
  open) [ $# -ge 2 ] || usage; need; cmd_open "$2" "${3:-}" "${4:-}" ;;
  open-setup) [ $# -ge 2 ] || usage; need; cmd_open_setup "$2" "${3:-}" "${4:-}" ;;
  start) check_clip "${2:-}"; need; clip="$2"; shift 2; cmd_start "$clip" "$@" ;;
  mark) need; cmd_mark "${2:-}" ;;
  type) [ $# -ge 2 ] || usage; need; shift; bun "$REPO/scripts/cdp-type.ts" "$@" ;;
  enter) need; bun "$REPO/scripts/cdp-type.ts" $'\n' ;;
  stop) check_clip "${2:-}"; need; cmd_stop "$2" ;;
  scan) check_clip "${2:-}"; cmd_scan "$2" "${3:-}" ;;
  *) usage ;;
esac
