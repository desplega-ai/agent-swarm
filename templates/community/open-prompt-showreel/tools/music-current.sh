#!/usr/bin/env bash
# Writes the music file that render.mjs reads: the credit json from fetch-music.sh plus the cut wav.
#
#   music-current.sh <track.json> <cut.wav> [out.json]       # out.json defaults to <cut.wav dir>/current.json
#
# Run it after music-cut.sh and before the final render. It adds two things to the track json:
#   wav          the cut wav, as given (render.mjs muxes it in; without it the video is silent)
#   attribution  the full credit for the post: title, artist, source link, license link and, for
#                CC BY, a notice that the track was edited (CC BY requires all of these)
# `credit` stays the short line for the end card. MODIFIED overrides the default edit description.
set -euo pipefail

track=${1:?usage: music-current.sh <track.json> <cut.wav> [out.json]} wav=${2:?missing <cut.wav>}
out=${3:-$(dirname "$wav")/current.json}
[ -f "$track" ] || { echo "no such track json: $track" >&2; exit 1; }
[ -s "$wav" ] || { echo "no such wav (run music-cut.sh first): $wav" >&2; exit 1; }

MODIFIED=${MODIFIED:-"trimmed, time-stretched to the video's beat grid, faded in and out, and loudness-normalized"} \
python3 - "$track" "$wav" "$out" <<'EOF'
import json, os, sys
track, wav, out = sys.argv[1:]
m = json.load(open(track))
for k in ("title", "artist", "license", "license_url", "source", "credit"):
    if not m.get(k):
        sys.exit(f"{track} has no '{k}'; re-run fetch-music.sh (older credit files lack license_url)")
m["wav"] = wav
m["attribution"] = f'"{m["title"]}" by {m["artist"]}, {m["source"]}, licensed under {m["license"]}, {m["license_url"]}.'
if m["license"].startswith("CC BY"):
    m["modified"] = os.environ["MODIFIED"]
    m["attribution"] += f' Changes: {m["modified"]}.'
json.dump(m, open(out, "w"), indent=2)
print(out)
print(m["attribution"])
EOF
