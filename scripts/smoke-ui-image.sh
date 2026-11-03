#!/usr/bin/env bash
# Runs the dashboard image the way production should (non-root, read-only root,
# no capabilities) and checks what nginx actually serves.
# Usage: scripts/smoke-ui-image.sh <image>
set -euo pipefail

image=${1:?usage: smoke-ui-image.sh <image>}
name="ui-smoke-$$"
shared="ui-smoke-share-$$"
stub="ui-smoke-api-$$"
net="ui-smoke-net-$$"
baddns="ui-smoke-baddns-$$"
badport="ui-smoke-badport-$$"
key="SMOKE-DUMMY-KEY-$$"
fail=0

cleanup() {
  docker rm -f "$name" "$shared" "$stub" "$baddns" "$badport" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

check() {
  if [[ "$2" == "$3" ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1: expected [$3], got [$2]"
    fail=1
  fi
}

check "image user is non-root" "$(docker image inspect "$image" --format '{{.Config.User}}')" "101"

# run_ui <container> [docker run args...]: start the image hardened, print its base URL.
run_ui() {
  local container=$1
  shift
  docker run -d --name "$container" --read-only --tmpfs /tmp --cap-drop ALL \
    --security-opt no-new-privileges -p 127.0.0.1::8080 "$@" "$image" >/dev/null
  local url
  url="http://127.0.0.1:$(docker port "$container" 8080/tcp | head -1 | sed 's/.*://')"
  for _ in $(seq 1 30); do
    curl -fs "$url/healthz" >/dev/null && break
    sleep 0.5
  done
  echo "$url"
}

base=$(run_ui "$name")

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

check "/api/og status" "$(status "$base/api/og?title=Hello&subtitle=World")" "200"
check "/api/og serves the generic card image" "$(ctype "$base/api/og?title=Hello&subtitle=World")" "image/png"
crawler="Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"
og() { curl -s "${@:2}" | grep -oE "property=\"$1\" content=\"[^\"]*\"" | head -1 | sed 's/.*content="//; s/"$//'; }
varies_on_ua() { curl -s -D - -o /dev/null "$@" | tr -d '\r' | grep -ci '^vary: User-Agent$' || true; }
check "crawler on /pages/:id status" "$(status -A "$crawler" "$base/pages/abc123")" "200"
check "no API: crawler on /pages/:id gets the generic card" "$(og og:image -A "$crawler" "$base/pages/abc123" | sed 's/.*\///')" "og-image.png"
check "crawler on /pages/:id not stored by a shared cache" "$(header cache-control -A "$crawler" "$base/pages/abc123")" "private, no-store"
check "/pages/:id varies on User-Agent" "$(varies_on_ua "$base/pages/abc123")" "1"
check "browser on /pages/:id keeps the SPA cache" "$(header cache-control "$base/pages/abc123")" "no-cache"

check "missing asset" "$(status "$base/assets/missing-$$.js")" "404"
check "missing asset not cached" "$(header cache-control "$base/assets/missing-$$.js")" ""
check "source map denied" "$(status "$base/assets/index.js.map")" "404"
check "dotfile denied" "$(status "$base/.env")" "404"

# Self-hosted page previews: SWARM_API_URL makes nginx proxy a bot's /pages/:id to the
# API's crawler view (GET /p/:id/share). The stub answers abc123 like a public page and
# 404s everything else, like a private or missing page.
docker network create "$net" >/dev/null
docker run -d --name "$stub" --network "$net" busybox:1.37 sh -c '
  mkdir -p /www/p/abc123 &&
  printf "%s" "<!doctype html><html><head><meta property=\"og:title\" content=\"Stub page title\"><meta property=\"og:image\" content=\"https://api.example.test/p/abc123/og.png\"></head><body></body></html>" > /www/p/abc123/share &&
  exec httpd -f -p 8000 -h /www' >/dev/null
shared_base=$(run_ui "$shared" --network "$net" -e SWARM_API_URL="http://$stub:8000/")
check "SWARM_API_URL logged at start" "$(docker logs "$shared" 2>&1 | grep -c "page link previews from http://$stub:8000" || true)" "1"
check "API: crawler on a public /pages/:id gets the page title" "$(og og:title -A "$crawler" "$shared_base/pages/abc123")" "Stub page title"
check "API: crawler on a public /pages/:id gets the API card" "$(og og:image -A "$crawler" "$shared_base/pages/abc123")" "https://api.example.test/p/abc123/og.png"
check "API: crawler preview not stored by a shared cache" "$(header cache-control -A "$crawler" "$shared_base/pages/abc123")" "private, no-store"
check "API: crawler preview varies on User-Agent" "$(varies_on_ua -A "$crawler" "$shared_base/pages/abc123")" "1"
check "API: a query string keeps the preview" "$(og og:title -A "$crawler" "$shared_base/pages/abc123?apiKey=$key")" "Stub page title"
check "API: crawler on a private /pages/:id gets the generic card" "$(og og:image -A "$crawler" "$shared_base/pages/private456" | sed 's/.*\///')" "og-image.png"
check "API: crawler on a private /pages/:id status" "$(status -A "$crawler" "$shared_base/pages/private456")" "200"
check "API: browser on /pages/:id gets the SPA" "$(og og:image "$shared_base/pages/abc123" | sed 's/.*\///')" "og-image.png"
docker stop -t 1 "$stub" >/dev/null
check "API down: crawler still gets the generic card" "$(og og:image -A "$crawler" "$shared_base/pages/abc123" | sed 's/.*\///')" "og-image.png"

# Whatever SWARM_API_URL holds, the dashboard starts: nginx resolves the API per request.
baddns_base=$(run_ui "$baddns" -e SWARM_API_URL="http://no-such-api.invalid:3013")
check "unresolvable API host: dashboard starts" "$(status "$baddns_base/healthz")" "200"
check "unresolvable API host: crawler gets the generic card" "$(og og:image -A "$crawler" "$baddns_base/pages/abc123" | sed 's/.*\///')" "og-image.png"
badport_base=$(run_ui "$badport" -e SWARM_API_URL="http://api.example.test:99999")
check "out-of-range API port: dashboard starts" "$(status "$badport_base/healthz")" "200"
check "out-of-range API port logged" "$(docker logs "$badport" 2>&1 | grep -c "port '99999' is out of range" || true)" "1"
check "out-of-range API port: crawler gets the generic card" "$(og og:image -A "$crawler" "$badport_base/pages/abc123" | sed 's/.*\///')" "og-image.png"

check "nosniff" "$(header x-content-type-options "$base/")" "nosniff"
check "referrer policy" "$(header referrer-policy "$base/")" "no-referrer"
check "csp" "$(header content-security-policy "$base/")" "frame-ancestors 'self'; object-src 'none'; base-uri 'self'"
check "nosniff on 404" "$(header x-content-type-options "$base/assets/missing-$$.js")" "nosniff"

status "$base/?apiUrl=https%3A%2F%2Fapi.example.test&apiKey=$key" >/dev/null
sleep 0.5
check "connection key kept out of access log" "$(docker logs "$name" 2>&1 | grep -c "$key" || true)" "0"
check "access log still records requests" "$(docker logs "$name" 2>&1 | grep -c '"GET / HTTP/1.1" 200' | awk '{print ($1 > 0) ? "yes" : "no"}')" "yes"

exit "$fail"
