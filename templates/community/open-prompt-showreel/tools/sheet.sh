#!/usr/bin/env bash
# Contact sheet: render stills across the timeline and tile them with ffmpeg xstack.
#
#   sheet.sh <w> <h> <name> [frames]
#
# Default is 16 frames spread over the reel, tiled 4x4. Pass a comma list to look at specific frames
# (a transition strip is 20 frames with COLS=5). The count must be a multiple of COLS.
# Needs the same env as render.mjs: REEL, FACTS, LOGO, FONTS (and optional MUSIC, FRAMES_TOTAL).
# Writes stills/<name>/fNNN.png and <name>.png in the current directory.
set -euo pipefail

W=$1 H=$2 NAME=$3
TOOLS="$(cd "$(dirname "$0")" && pwd)"
: "${REEL:?set REEL=reel.html}" "${FACTS:?set FACTS=facts.json}" "${LOGO:?set LOGO=logo.png}" "${FONTS:?set FONTS=SG=a.ttf,JB=b.ttf}"
TOTAL=${FRAMES_TOTAL:-720}

if [ -n "${4:-}" ]; then
  FR=$4
else
  FR=$(awk -v n="$TOTAL" 'BEGIN { for (i = 0; i < 16; i++) printf "%s%d", (i ? "," : ""), int((i + 0.5) * n / 16) }')
fi

rm -rf "stills/$NAME"
node "$TOOLS/render.mjs" --reel "$REEL" --w "$W" --h "$H" --facts "$FACTS" --logo "$LOGO" --fonts "$FONTS" \
  ${MUSIC:+--music "$MUSIC"} --out "stills/$NAME" --at "$FR" 2>/dev/null

COUNT=$(awk -F, '{ print NF }' <<<"$FR")
COLS=${COLS:-4}
if [ $((COUNT % COLS)) -ne 0 ]; then
  echo "frame count $COUNT does not fill a grid of $COLS columns; pass a multiple of COLS" >&2
  exit 1
fi
ROWS=$((COUNT / COLS))
inputs=() filt=""
i=0
for f in ${FR//,/ }; do
  inputs+=(-i "stills/$NAME/f$(printf %03d "$f").png")
  filt+="[$i]scale=iw/${COLS}:-1,pad=iw+4:ih+4:2:2:gray[s$i];"
  i=$((i + 1))
done
for j in $(seq 0 $((COUNT - 1))); do filt+="[s$j]"; done
filt+="xstack=inputs=$COUNT:grid=${COLS}x${ROWS}"
ffmpeg -v error -y "${inputs[@]}" -filter_complex "$filt" "$NAME.png"
echo "$NAME.png (${COUNT} frames, ${COLS}x${ROWS})"
