#!/usr/bin/env bash
# Downloads one CC0 / CC BY track and writes the credit file the reel and the output need.
#
#   fetch-music.sh incompetech <Title> <out-dir>          # Kevin MacLeod, CC BY 4.0
#   fetch-music.sh url <audio-url> <out-dir> <title> <artist> <license> <source-page>
#
# Writes <out-dir>/<slug>.<ext> and <out-dir>/<slug>.json = { title, artist, license, source, credit }.
# Only CC0 and CC BY. No NC (it is a company post) and no ND (we cut and stretch the track).
set -euo pipefail

mode=$1
case "$mode" in
  incompetech)
    title=$2 outdir=$3
    url="https://incompetech.com/music/royalty-free/mp3-royaltyfree/${title// /%20}.mp3"
    artist="Kevin MacLeod" license="CC BY 4.0" source="https://incompetech.com"
    ;;
  url)
    url=$2 outdir=$3 title=$4 artist=$5 license=$6 source=$7
    ;;
  *)
    echo "usage: fetch-music.sh incompetech <Title> <out-dir> | url <url> <out-dir> <title> <artist> <license> <source>" >&2
    exit 2
    ;;
esac

case "$license" in
  *NC* | *ND*) echo "refusing license '$license': only CC0 and CC BY are allowed" >&2; exit 1 ;;
esac

mkdir -p "$outdir"
slug=$(tr '[:upper:] ' '[:lower:]-' <<<"$title" | tr -cd 'a-z0-9-')
ext="${url##*.}"
curl -fsSL "$url" -o "$outdir/$slug.$ext"
python3 - "$outdir/$slug.json" "$title" "$artist" "$license" "$source" <<'EOF'
import json, sys
path, title, artist, license, source = sys.argv[1:]
credit = f'"{title}" by {artist} ({source.split("//")[-1].split("/")[0]}) · {license}'
json.dump({"title": title, "artist": artist, "license": license, "source": source, "credit": credit}, open(path, "w"))
print(credit)
EOF
echo "$outdir/$slug.$ext $(stat -c%s "$outdir/$slug.$ext") bytes"
