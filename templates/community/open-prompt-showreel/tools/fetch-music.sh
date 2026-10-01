#!/usr/bin/env bash
# Downloads one CC0 / CC BY track and writes the credit file the reel and the output need.
#
#   fetch-music.sh incompetech <Title> <out-dir>          # Kevin MacLeod, CC BY 4.0
#   fetch-music.sh url <audio-url> <out-dir> <title> <artist> <license> <source-page>
#
# Writes <out-dir>/<slug>.<ext> and <out-dir>/<slug>.json =
#   { title, artist, license, license_url, source, credit }
# `credit` is the short line for the end card. The full attribution (source link, license link and
# the modification notice) is added by music-current.sh once the track has been cut.
#
# Allowlist: CC0 1.0 and CC BY 1.0 to 4.0, matched case-insensitively ("cc-by 4.0" works). Everything
# else is refused: NC (it is a company post), ND (we cut and stretch the track), SA (it would carry
# over to the video), "All rights reserved", unknown strings. Check the license on the source page
# yourself; the script cannot.
set -euo pipefail

mode=${1:-}
case "$mode" in
  incompetech)
    title=$2 outdir=$3
    url="https://incompetech.com/music/royalty-free/mp3-royaltyfree/${title// /%20}.mp3"
    # Kevin MacLeod asks for the site root, not a per-track page.
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

# Normalize ("cc-by_4.0" -> "CC BY 4.0") and map to the canonical name and the license deed URL.
norm=$(tr '[:lower:]' '[:upper:]' <<<"$license" | tr -s ' _-' ' ' | sed 's/^ //; s/ $//')
if [[ "$norm" =~ ^CC\ ?0(\ 1\.0)?(\ UNIVERSAL)?$ ]]; then
  license="CC0 1.0" license_url="https://creativecommons.org/publicdomain/zero/1.0/"
elif [[ "$norm" =~ ^CC\ BY\ (1\.0|2\.0|2\.5|3\.0|4\.0)$ ]]; then
  license="CC BY ${BASH_REMATCH[1]}" license_url="https://creativecommons.org/licenses/by/${BASH_REMATCH[1]}/"
else
  echo "refusing license '$license': only CC0 1.0 and CC BY 1.0-4.0 are allowed (no NC, ND, SA or unknown terms)" >&2
  exit 1
fi
case "$source" in
  http://* | https://*) ;;
  *) echo "source must be a http(s) link to the track's page, got '$source'" >&2; exit 1 ;;
esac

mkdir -p "$outdir"
slug=$(tr '[:upper:] ' '[:lower:]-' <<<"$title" | tr -cd 'a-z0-9-')
ext="${url##*.}"
curl -fsSL "$url" -o "$outdir/$slug.$ext"
python3 - "$outdir/$slug.json" "$title" "$artist" "$license" "$license_url" "$source" <<'EOF'
import json, sys
path, title, artist, license, license_url, source = sys.argv[1:]
credit = f'"{title}" by {artist} ({source.split("//")[-1].split("/")[0]}) · {license}'
json.dump(
    {"title": title, "artist": artist, "license": license, "license_url": license_url, "source": source, "credit": credit},
    open(path, "w"),
    indent=2,
)
print(credit)
EOF
echo "$outdir/$slug.$ext $(stat -c%s "$outdir/$slug.$ext") bytes"
