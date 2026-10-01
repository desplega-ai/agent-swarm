#!/usr/bin/env bash
# Smoke test for the toolchain: renders the TLA+ example reel to a 16-frame contact sheet and a
# 2-second silent mp4, then checks the mp4 pixel format. No network, no gh, no agent-fs.
#
#   . ../../env.sh && bash smoke.sh        (env.sh is written by setup.sh)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$HERE/../../tools"
: "${FONTS:?source env.sh first}" "${LOGO:?source env.sh first}"
OUT="${OUT:-$(mktemp -d)}"
export REEL="$HERE/reel.html" FACTS="$HERE/facts.v3.json" MUSIC="$HERE/music.mist-city.json"

mkdir -p "$OUT" && cd "$OUT"
bash "$TOOLS/sheet.sh" 960 540 smoke
node "$TOOLS/render.mjs" --reel "$REEL" --w 960 --h 540 --facts "$FACTS" --logo "$LOGO" --fonts "$FONTS" \
  --music "$MUSIC" --frames 60 --out smoke.mp4 2>/dev/null
# `ffmpeg -i` with no output exits 1, hence the || true (pipefail would otherwise end the script here).
stream=$(ffmpeg -hide_banner -i smoke.mp4 2>&1 | grep -m1 'Stream.*Video' || true)
echo "smoke.mp4: ${stream#*Video: }"
case "$stream" in
  *yuv420p*960x540*) echo "OK: yuv420p 960x540" ;;
  *) echo "FAIL: expected yuv420p 960x540" >&2; exit 1 ;;
esac
echo "outputs in $OUT: $(ls "$OUT" | tr '\n' ' ')"
