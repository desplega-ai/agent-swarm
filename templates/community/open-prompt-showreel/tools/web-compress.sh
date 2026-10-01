#!/usr/bin/env bash
# Makes a small web copy of a master render (for docs pages and PR bodies) plus a poster frame.
#
#   web-compress.sh <master.mp4> <out-dir> <name> [poster-second]
#
# Writes <out-dir>/<name>.mp4 (1280 px wide, h264 yuv420p, AAC 96k, faststart) and <out-dir>/<name>.jpg.
# Keep the master in agent-fs; commit only this copy. A signed agent-fs URL expires, a file in the repo does not.
set -euo pipefail

in=$1 outdir=$2 name=$3 poster=${4:-20}
mkdir -p "$outdir"
ffmpeg -v error -y -i "$in" \
  -vf "scale=1280:-2:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset slow -crf "${CRF:-27}" -profile:v high -pix_fmt yuv420p -color_range tv \
  -c:a aac -b:a 96k -movflags +faststart "$outdir/$name.mp4"
ffmpeg -v error -y -ss "$poster" -i "$in" -frames:v 1 -vf "scale=1280:-2:flags=lanczos" -q:v 4 "$outdir/$name.jpg"
ls -l "$outdir/$name.mp4" "$outdir/$name.jpg" | awk '{ print $5, $9 }'
