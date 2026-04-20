#!/usr/bin/env bash
# Regenerate the ambient synth bed used by both compositions.
# Requires ffmpeg. Output: public/audio/bed.mp3 (~50s mono, 64kbps).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/audio
ffmpeg -y -f lavfi \
  -i "sine=frequency=110:sample_rate=44100:duration=50, \
      tremolo=f=0.15:d=0.25, \
      lowpass=f=600, \
      volume=0.18, \
      afade=t=in:d=2, \
      afade=t=out:st=47:d=3" \
  -f lavfi \
  -i "sine=frequency=165:sample_rate=44100:duration=50, \
      tremolo=f=0.1:d=0.2, \
      lowpass=f=500, \
      volume=0.08, \
      afade=t=in:d=3, \
      afade=t=out:st=46:d=4" \
  -f lavfi \
  -i "anoisesrc=c=pink:d=50:a=0.02" \
  -filter_complex "[0][1][2]amix=inputs=3:duration=shortest:weights=1 0.7 0.35" \
  -codec:a libmp3lame -b:a 64k -ac 1 public/audio/bed.mp3
