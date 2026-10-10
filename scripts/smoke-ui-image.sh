#!/usr/bin/env bash
# Runs the dashboard image the way production should (non-root, read-only root,
# no capabilities) and checks what nginx actually serves.
# Usage: scripts/smoke-ui-image.sh <image>
set -euo pipefail

image=${1:?usage: smoke-ui-image.sh <image>}
name="ui-smoke-$$"
key="SMOKE-DUMMY-KEY-$$"
fail=0

trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

check() {
  if [[ "$2" == "$3" ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1: expected [$3], got [$2]"
    fail=1
  fi
}

check "image user is non-root" "$(docker image inspect "$image" --format '{{.Config.User}}')" "101"

docker run -d --name "$name" --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges -p 127.0.0.1::8080 "$image" >/dev/null
port=$(docker port "$name" 8080/tcp | head -1 | sed 's/.*://')
base="http://127.0.0.1:$port"
for _ in $(seq 1 30); do
  curl -fs "$base/healthz" >/dev/null && break
  sleep 0.5
done

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
ctype() { curl -s -o /dev/null -w '%{content_type}' "$1"; }
header() { curl -s -D - -o /dev/null "${@:2}" | tr -d '\r' | awk -v h="$1" 'tolower($0) ~ "^" tolower(h) ":" { sub(/^[^:]*: */, ""); print; exit }'; }

check "/healthz" "$(status "$base/healthz")" "200"
check "/ status" "$(status "$base/")" "200"
check "/ content type" "$(ctype "$base/")" "text/html"
check "deep link falls back to index.html" "$(status "$base/settings/connections")" "200"
check "/version.json status" "$(status "$base/version.json")" "200"
check "/version.json cache" "$(header cache-control "$base/version.json")" "no-cache, no-store, must-revalidate"
check "index cache" "$(header cache-control "$base/")" "no-cache"

asset=$(curl -s "$base/" | grep -oE '/assets/[^"]+\.js' | head -1)
check "index references a hashed asset" "$([[ -n "$asset" ]] && echo yes)" "yes"
check "asset status" "$(status "$base$asset")" "200"
check "asset content type" "$(ctype "$base$asset")" "application/javascript"
check "asset cache" "$(header cache-control "$base$asset")" "public, max-age=31536000, immutable"
check "asset gzip" "$(header content-encoding -H 'Accept-Encoding: gzip' "$base$asset")" "gzip"
check "asset vary" "$(header vary -H 'Accept-Encoding: gzip' "$base$asset")" "Accept-Encoding"

check "missing asset" "$(status "$base/assets/missing-$$.js")" "404"
check "missing asset not cached" "$(header cache-control "$base/assets/missing-$$.js")" ""
check "source map denied" "$(status "$base/assets/index.js.map")" "404"
check "dotfile denied" "$(status "$base/.env")" "404"

check "nosniff" "$(header x-content-type-options "$base/")" "nosniff"
check "referrer policy" "$(header referrer-policy "$base/")" "no-referrer"
check "csp" "$(header content-security-policy "$base/")" "frame-ancestors 'self'; object-src 'none'; base-uri 'self'"
check "nosniff on 404" "$(header x-content-type-options "$base/assets/missing-$$.js")" "nosniff"

status "$base/?apiUrl=https%3A%2F%2Fapi.example.test&apiKey=$key" >/dev/null
sleep 0.5
check "connection key kept out of access log" "$(docker logs "$name" 2>&1 | grep -c "$key" || true)" "0"
check "access log still records requests" "$(docker logs "$name" 2>&1 | grep -c '"GET / HTTP/1.1" 200' | awk '{print ($1 > 0) ? "yes" : "no"}')" "yes"

exit "$fail"
