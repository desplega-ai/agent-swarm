#!/usr/bin/env bash
# Smoke test for the toolchain: renders the TLA+ example reel to a 16-frame contact sheet and a
# 2-second mp4 with a generated tone as the audio, and checks the pixel format and the AAC stream.
# Also checks that a failing encode makes render.mjs exit non-zero. No network, no gh, no agent-fs.
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

# A tone stands in for a cut track; music-current.sh adds the wav field, as in a real run.
ffmpeg -v error -y -f lavfi -i "sine=frequency=440:duration=3" -ar 48000 -ac 2 tone.wav
bash "$TOOLS/music-current.sh" "$MUSIC" tone.wav current.json >/dev/null
# out/ does not exist yet: render.mjs creates the output directory.
node "$TOOLS/render.mjs" --reel "$REEL" --w 960 --h 540 --facts "$FACTS" --logo "$LOGO" --fonts "$FONTS" \
  --music current.json --frames 60 --out out/smoke.mp4 2>/dev/null
# `ffmpeg -i` with no output exits 1, hence the || true (pipefail would otherwise end the script here).
info=$(ffmpeg -hide_banner -i out/smoke.mp4 2>&1 || true)
stream=$(grep -m1 'Stream.*Video' <<<"$info" || true)
audio=$(grep -m1 'Stream.*Audio' <<<"$info" || true)
echo "out/smoke.mp4: ${stream#*Video: }"
echo "out/smoke.mp4: ${audio#*Audio: }"
case "$stream" in
  *yuv420p*960x540*) echo "OK: yuv420p 960x540" ;;
  *) echo "FAIL: expected yuv420p 960x540" >&2; exit 1 ;;
esac
case "$audio" in
  *aac*) echo "OK: aac audio" ;;
  *) echo "FAIL: expected an aac audio stream" >&2; exit 1 ;;
esac

# A wav ffmpeg cannot read must fail the render and must not leave an mp4 behind.
echo "not audio" >bad.wav
bash "$TOOLS/music-current.sh" "$MUSIC" bad.wav bad.json >/dev/null
if node "$TOOLS/render.mjs" --reel "$REEL" --w 960 --h 540 --facts "$FACTS" --logo "$LOGO" --fonts "$FONTS" \
  --music bad.json --frames 2 --out bad/smoke.mp4 2>/dev/null; then
  echo "FAIL: render.mjs exited 0 after ffmpeg failed" >&2; exit 1
fi
[ ! -e bad/smoke.mp4 ] || { echo "FAIL: a failed render left bad/smoke.mp4" >&2; exit 1; }
echo "OK: failed encode exits non-zero"
echo "outputs in $OUT: $(ls "$OUT" | tr '\n' ' ')"
