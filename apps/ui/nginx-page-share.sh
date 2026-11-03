#!/bin/sh
# Runs from the nginx image's /docker-entrypoint.d/ before nginx starts.
# SWARM_API_URL (optional): the swarm API that serves page link previews, for
# example https://api.example.com. Writes the proxy_pass that nginx.conf's
# /__page_share/ location includes. Unset or invalid: no include, and every
# /pages/:id link keeps the generic preview. nginx resolves the host at start.
set -eu

dir=/tmp/nginx-page-share
mkdir -p "$dir"
rm -f "$dir/api.conf"

url=${SWARM_API_URL:-}
while [ "${url%/}" != "$url" ]; do url=${url%/}; done
[ -n "$url" ] || exit 0

# Strict on purpose: the value lands in nginx config.
if ! printf '%s' "$url" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$'; then
  echo "$0: SWARM_API_URL is not a plain http(s) URL; page links keep the generic preview" >&2
  exit 0
fi

origin=$(printf '%s' "$url" | sed -E 's#^(https?://[^/]+).*$#\1#')
prefix=${url#"$origin"}
printf 'set $page_share_prefix "%s";\nproxy_pass %s;\n' "$prefix" "$origin" > "$dir/api.conf"
echo "$0: page link previews from $origin$prefix"
