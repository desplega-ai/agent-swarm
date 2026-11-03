#!/bin/sh
# Runs from the nginx image's /docker-entrypoint.d/ before nginx starts.
# SWARM_API_URL (optional): the swarm API that serves page link previews, for
# example https://api.example.com. Writes the proxy_pass that nginx.conf's
# /__page_share/ location includes. Unset or invalid: no include, and every
# /pages/:id link keeps the generic preview.
#
# nginx resolves the host per request (resolver + variable proxy_pass), using
# the nameservers in /etc/resolv.conf, so a host that does not resolve, or a
# DNS outage, never stops nginx from starting: the bot gets the generic preview.
# nginx's resolver applies no resolv.conf search domains, so in Kubernetes give
# the service's full name (api.<namespace>.svc.cluster.local).
#
# Never fails: whatever SWARM_API_URL holds, the dashboard must start.
set -u

dir=${NGINX_PAGE_SHARE_DIR:-/tmp/nginx-page-share}
resolv_conf=${NGINX_PAGE_SHARE_RESOLV_CONF:-/etc/resolv.conf}
mkdir -p "$dir" && rm -f "$dir/api.conf" || exit 0

generic() {
  echo "$0: $1; page links keep the generic preview" >&2
  exit 0
}

url=${SWARM_API_URL:-}
while [ "${url%/}" != "$url" ]; do url=${url%/}; done
[ -n "$url" ] || exit 0

# Strict on purpose: the value lands in nginx config.
printf '%s' "$url" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$' ||
  generic "SWARM_API_URL is not a plain http(s) URL"

origin=$(printf '%s' "$url" | sed -E 's#^(https?://[^/]+).*$#\1#')
prefix=${url#"$origin"}
scheme=${origin%%://*}
authority=${origin#*://}
host=${authority%%:*}
port=
case $authority in *:*) port=${authority#*:} ;; esac

printf '%s' "$host" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$' ||
  generic "SWARM_API_URL host '$host' is not a valid hostname"

if [ -n "$port" ]; then
  port=$(printf '%s' "$port" | sed 's/^0*//')
  if [ -z "$port" ] || [ "$port" -gt 65535 ]; then
    generic "SWARM_API_URL port '${authority#*:}' is out of range (1-65535)"
  fi
  authority="$host:$port"
fi

# nginx's resolver does not read /etc/hosts.
[ "$host" = localhost ] && authority="127.0.0.1${port:+:$port}"

resolver=
if ! printf '%s' "${authority%%:*}" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
  for ns in $(awk '$1 == "nameserver" { print $2 }' "$resolv_conf" 2>/dev/null); do
    if printf '%s' "$ns" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
      resolver="$resolver $ns"
    elif printf '%s' "$ns" | grep -Eq '^[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*$'; then
      resolver="$resolver [$ns]"
    fi
  done
  [ -n "$resolver" ] || generic "no nameserver in $resolv_conf to resolve SWARM_API_URL host '$host'"
  case $host in
    *.*) ;;
    *) echo "$0: SWARM_API_URL host '$host' has no dot; nginx's resolver applies no search domains" >&2 ;;
  esac
fi

{
  [ -z "$resolver" ] || printf 'resolver%s valid=30s;\nresolver_timeout 2s;\n' "$resolver"
  printf 'set $page_share_prefix "%s";\n' "$prefix"
  printf 'set $page_share_upstream "%s://%s";\n' "$scheme" "$authority"
  printf 'proxy_pass $page_share_upstream;\n'
} > "$dir/api.conf.tmp" && mv "$dir/api.conf.tmp" "$dir/api.conf" ||
  generic "could not write $dir/api.conf"
echo "$0: page link previews from $scheme://$authority$prefix"
