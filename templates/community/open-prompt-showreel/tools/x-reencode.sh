#!/usr/bin/env bash
# Re-encodes an mp4 to limited-range (tv) yuv420p / bt709, the shape social uploaders handle reliably.
#
#   x-reencode.sh <in.mp4> <out.mp4>
#
# Why: a clip made from JPEG frames, a screen recording or a camera export is often tagged
# yuvj420p (full range, "pc"). ffmpeg reproduces that tag; whether X rejects such a file is a
# field report from our own posting runs, not something this script proves. The render pipeline
# in render.mjs already emits yuv420p/tv, so run this only on clips that came from somewhere else.
set -euo pipefail

in=$1 out=$2
fmt=$(ffmpeg -hide_banner -i "$in" 2>&1 | grep -m1 'Stream.*Video' || true)
echo "before: ${fmt#*Video: }"
ffmpeg -v error -y -i "$in" \
  -vf "scale=in_range=auto:out_range=tv:out_color_matrix=bt709,format=yuv420p" \
  -c:v libx264 -preset slow -crf 16 -profile:v high -pix_fmt yuv420p \
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -c:a copy -movflags +faststart "$out"
fmt=$(ffmpeg -hide_banner -i "$out" 2>&1 | grep -m1 'Stream.*Video' || true)
echo "after:  ${fmt#*Video: }"
