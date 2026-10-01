#!/usr/bin/env bash
# Time-stretches a track so its beats sit on the reel's frame grid and its drop lands on the key reveal.
#
#   music-cut.sh <in> <track_bpm> <drop_sec_in_track> <out.wav>
#
# Get <track_bpm> and <drop_sec_in_track> from music-analyze.py / music-refine.py.
# Env (defaults match the TLA+ reel: 30 fps, 120 BPM = 15 frames per beat, drop at 14.0 s, 24 s cut):
#   TARGET_BPM=120  DROP_AT=14.0  DUR=24  DIP=0
# DIP=1 ducks the track by ~86% for the 0.6 s before the drop, then snaps it back on the drop.
set -euo pipefail

in=$1 bpm=$2 drop=$3 out=$4
target=${TARGET_BPM:-120} drop_at=${DROP_AT:-14.0} dur=${DUR:-24}

# atempo ratio, where in the source to start, and how much source to read.
read -r a start len < <(python3 - "$bpm" "$drop" "$target" "$drop_at" "$dur" <<'EOF'
import sys
bpm, drop, target, drop_at, dur = map(float, sys.argv[1:])
a = target / bpm
print(a, drop - drop_at * a, (dur + 0.6) * a)
EOF
)
if python3 -c "import sys; sys.exit(0 if $start < 0 else 1)"; then
  echo "drop too early in the track: start=$start" >&2
  exit 1
fi

env="afade=t=in:st=0:d=0.3,afade=t=out:st=$(python3 -c "print($dur - 1.7)"):d=1.7"
if [ "${DIP:-0}" = 1 ]; then
  d0=$(python3 -c "print($drop_at - 0.6)")
  env="$env,volume='1-0.86*min(1,max(0,(t-$d0)/0.06))*min(1,max(0,($drop_at-t)/0.02))':eval=frame"
fi
ffmpeg -v error -y -ss "$start" -t "$len" -i "$in" \
  -af "atempo=$a,atrim=0:$dur,asetpts=N/SR/TB,$env,loudnorm=I=-14:TP=-1.5:LRA=11" \
  -ar 48000 -ac 2 "$out"
echo "atempo=$a start=$start"
