#!/usr/bin/env bash
# Full self-hosted stack on a QA box: the Compose example (API, lead, workers,
# agent-fs, MinIO) behind Caddy HTTPS on real subdomains of agent-swarm.dev.
#
#   stack.sh up <run> <api-sub> [options]   box + DNS + stack, then wait for HTTPS and the agents
#   stack.sh smoke <run> [secs]             pin one task to a worker (write a file to agent-fs), print the result
#   stack.sh down <run>                     delete the DNS records, the box and its firewall
#
# up options:
#   --fs-sub <sub>        agent-fs host (default <api-sub>-fs)
#   --version <x.y.z>     release to pin (default: the latest GitHub release)
#   --ref <git ref>       take the Compose files from this branch, tag or commit, not from the
#                         release tag. The image tag then defaults to sha-<first 7 of the commit>
#   --image-tag <tag>     image tag of the API and the agents (default: the version, or the --ref default)
#   --overlay <name>      also use docker-compose.<name>.yml from the same ref (repeat): postgres, tei
#   --fs-storage <kind>   agent-fs storage: minio (default) or local (its own volume, no MinIO)
#   --agents "<svc> ..."  Compose agent services (default "lead worker-1" = lead + official/coder)
#   --key KEY             copy KEY from the env file into the stack .env (repeat). Default: none,
#                         the operator adds credentials in /setup like a real user
#   --telemetry-env <v>   DESPLEGA_TELEMETRY_ENV for every container from first boot (default onboarding-qa)
#   --keep                label the box keep=true so box.sh reap skips it (demos that outlive 6 h)
#
# The box is cx43 (else cpx42, 8 vCPU / 16 GB) + docker-ce + a 22/80/443-only firewall.
# The stack lives in /root/swarm. API_KEY, the MinIO password and the overlay passwords are
# generated on the box. With an overlay, .env sets COMPOSE_FILE, so a plain `docker compose`
# in /root/swarm uses every file.
# /tmp/onboarding-qa-<run>/setup-url gets the dashboard link (API key inside, mode 600):
# open it with secrets.sh open-setup <run>. DNS: ONBOARDING_QA_DNS_DOMAIN (agent-swarm.dev),
# ONBOARDING_QA_VERCEL_SCOPE (desplega-labs).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
DNS_DOMAIN="${ONBOARDING_QA_DNS_DOMAIN:-agent-swarm.dev}"
VERCEL_SCOPE="${ONBOARDING_QA_VERCEL_SCOPE:-desplega-labs}"
REPO=desplega-ai/agent-swarm
REPO_OWNER="${REPO%%/*}"
DASHBOARD=https://app.agent-swarm.dev

usage() { sed -n '2,29p' "$0"; exit 2; }
bcn() { TZ=Europe/Madrid date '+%H:%M:%S'; }
api() { bash "$here/box-api.sh" "$run" "$@" | sed '$d'; }

check_sub() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$ ]] || { echo "bad subdomain: '$1'" >&2; exit 2; }
}

dns_add() {
  local sub="$1" ip="$2" records existing id
  records="$(vercel dns ls "$DNS_DOMAIN" --scope "$VERCEL_SCOPE" --limit 100 2>/dev/null)"
  [ "$(grep -c 'rec_' <<<"$records")" -lt 100 ] || { echo "100+ records: check $sub by hand" >&2; exit 1; }
  existing="$(awk -v n="$sub" '$1 ~ /^rec_/ && $2 == n {print $1}' <<<"$records")"
  if [ -n "$existing" ]; then
    # Ours from an earlier `up` of this run: keep it. Anyone else's: never touch it.
    grep -q "^$existing " "$dir/dns-records" 2>/dev/null && { echo "dns $sub.$DNS_DOMAIN kept ($existing)"; return; }
    echo "$sub.$DNS_DOMAIN already has a record ($existing). Pick another subdomain." >&2
    exit 1
  fi
  id="$(vercel dns add "$DNS_DOMAIN" "$sub" A "$ip" --scope "$VERCEL_SCOPE" 2>&1 | grep -oE 'rec_[A-Za-z0-9]+' | head -1)"
  [ -n "$id" ] || { echo "vercel dns add $sub failed" >&2; exit 1; }
  echo "$id $sub" >>"$dir/dns-records"
  echo "dns $sub.$DNS_DOMAIN -> $ip ($id)"
}

dns_rm() {
  [ -f "$dir/dns-records" ] || { echo "no $dir/dns-records: no DNS records to delete"; return; }
  while read -r id sub; do
    vercel dns rm "$id" --yes --scope "$VERCEL_SCOPE" >/dev/null 2>&1 &&
      echo "deleted dns $sub.$DNS_DOMAIN ($id)" ||
      echo "could not delete dns $sub.$DNS_DOMAIN ($id): check vercel dns ls $DNS_DOMAIN" >&2
  done <"$dir/dns-records"
  rm -f "$dir/dns-records"
}

# A tag that is not published shows only as a failed pull, after the box exists. Check it first.
image_check() {
  local img token code accept
  accept='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
  for img in agent-swarm agent-swarm-worker; do
    token="$(curl -fsS "https://ghcr.io/token?scope=repository:$REPO_OWNER/$img:pull" | jq -r .token)"
    code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" -H "Accept: $accept" \
      "https://ghcr.io/v2/$REPO_OWNER/$img/manifests/$1")"
    [ "$code" = 200 ] || { echo "no image ghcr.io/$REPO_OWNER/$img:$1 (HTTP $code)" >&2; exit 1; }
  done
}

cmd_up() {
  local api_sub="" fs_sub="" version="" agents="lead worker-1" telemetry=onboarding-qa keep="" keys=()
  local ref="" image_tag="" overlays="" fs_storage=minio
  api_sub="${1:-}"
  [ -n "$api_sub" ] || usage
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --fs-sub) fs_sub="${2:?}"; shift 2 ;;
      --version) version="${2:?}"; shift 2 ;;
      --ref) ref="${2:?}"; shift 2 ;;
      --image-tag) image_tag="${2:?}"; shift 2 ;;
      --overlay) overlays="${overlays:+$overlays }${2:?}"; shift 2 ;;
      --fs-storage) fs_storage="${2:?}"; shift 2 ;;
      --agents) agents="${2:?}"; shift 2 ;;
      --key) keys+=("${2:?}"); shift 2 ;;
      --telemetry-env) telemetry="${2:?}"; shift 2 ;;
      --keep) keep=1; shift ;;
      *) usage ;;
    esac
  done
  fs_sub="${fs_sub:-$api_sub-fs}"
  check_sub "$api_sub"
  check_sub "$fs_sub"
  [[ "$agents" =~ ^[a-z0-9\ -]+$ ]] || { echo "bad --agents: '$agents'" >&2; exit 2; }
  [[ "$telemetry" =~ ^[a-z0-9-]+$ ]] || { echo "bad --telemetry-env: '$telemetry'" >&2; exit 2; }
  [[ "$overlays" =~ ^([a-z0-9][a-z0-9-]*( |$))*$ ]] || { echo "bad --overlay: '$overlays'" >&2; exit 2; }
  case "$fs_storage" in minio | local) ;; *) echo "bad --fs-storage: '$fs_storage' (minio or local)" >&2; exit 2 ;; esac
  local custom="$ref$image_tag"
  if [ -n "$ref" ]; then
    # A full commit id pins the files: a branch can move between two `up` runs.
    [ -z "$version" ] || { echo "--ref and --version exclude each other" >&2; exit 2; }
    [[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "bad --ref: '$ref'" >&2; exit 2; }
    ref="$(gh api "repos/$REPO/commits/$ref" -q .sha)" || { echo "no such ref in $REPO" >&2; exit 2; }
    image_tag="${image_tag:-sha-${ref:0:7}}"
  else
    if [ -z "$version" ]; then
      version="$(gh release list -R "$REPO" -L 1 --exclude-drafts --exclude-pre-releases --json tagName -q '.[0].tagName')"
    fi
    version="${version#v}"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version: '$version'" >&2; exit 2; }
    ref="v$version"
    image_tag="${image_tag:-$version}"
  fi
  [[ "$image_tag" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || { echo "bad --image-tag: '$image_tag'" >&2; exit 2; }
  [ -z "$custom" ] || image_check "$image_tag"
  local api_host="$api_sub.$DNS_DOMAIN" fs_host="$fs_sub.$DNS_DOMAIN" started ip
  started=$(date +%s)

  if [ -f "$dir/run.env" ]; then
    echo "box exists ($dir/run.env), reusing it"
  else
    ONBOARDING_QA_SERVER_TYPE="${ONBOARDING_QA_SERVER_TYPE:-cx43,cpx42}" ONBOARDING_QA_FIREWALL=web \
      ONBOARDING_QA_KEEP="$keep" bash "$here/box.sh" up "$run" docker-ce
  fi
  ip="$(grep '^IP=' "$dir/run.env" | cut -d= -f2)"
  dns_add "$api_sub" "$ip"
  dns_add "$fs_sub" "$ip"

  # Stack files. Secrets are made on the box and never leave it; re-runs keep them.
  ssh -F "$dir/ssh_config" box bash -s -- "$ref" "$image_tag" "$api_host" "$fs_host" "$telemetry" \
    "$(printf '%q' "$agents")" "$(printf '%q' "$overlays")" "$fs_storage" <<'REMOTE'
set -euo pipefail
ref="$1" image_tag="$2" api_host="$3" fs_host="$4" telemetry="$5" agents="$6" overlays="$7" fs_storage="$8"
mkdir -p ~/swarm && cd ~/swarm && umask 077
raw="https://raw.githubusercontent.com/desplega-ai/agent-swarm/$ref"
curl -fsSL "$raw/docker-compose.example.yml" -o docker-compose.yml
files=docker-compose.yml
for o in $overlays; do
  curl -fsSL "$raw/docker-compose.$o.yml" -o "docker-compose.$o.yml" ||
    { echo "no docker-compose.$o.yml at $ref" >&2; exit 2; }
  files="$files:docker-compose.$o.yml"
done
touch .env
setkv() { { grep -v "^$1=" .env || true; printf '%s=%s\n' "$1" "$2"; } >.env.tmp && mv .env.tmp .env; }
getkv() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
setkv AGENT_SWARM_VERSION "$image_tag"
[ -n "$(getkv API_KEY)" ] || setkv API_KEY "$(openssl rand -hex 24)"
# The example needs the MinIO login in .env even when MinIO does not run (--fs-storage local).
[ -n "$(getkv MINIO_ROOT_PASSWORD)" ] || setkv MINIO_ROOT_PASSWORD "$(openssl rand -hex 24)"
setkv MINIO_ROOT_USER agentfs
setkv MCP_BASE_URL http://api:3013
setkv APP_URL https://app.agent-swarm.dev
setkv PUBLIC_MCP_BASE_URL "https://$api_host"
setkv SWARM_API_DOMAIN "$api_host"
setkv AGENT_FS_DOMAIN "$fs_host"
# What each overlay needs in .env. Passwords are hex: they also go into URLs.
for o in $overlays; do
  case "$o" in
    postgres) [ -n "$(getkv POSTGRES_PASSWORD)" ] || setkv POSTGRES_PASSWORD "$(openssl rand -hex 24)" ;;
  esac
done
# With COMPOSE_FILE set, Compose stops loading the override file by itself: list it too.
if [ -n "$overlays" ]; then
  setkv COMPOSE_FILE "$files:docker-compose.override.yml"
else
  { grep -v '^COMPOSE_FILE=' .env || true; } >.env.tmp && mv .env.tmp .env
fi
[ -s encryption_key ] || openssl rand -base64 32 >encryption_key
{
  if [ "$fs_storage" = local ]; then
    # The local provider cannot presign. `signed-url` returns a sign-in link to the dashboard
    # (AGENT_FS_APP_URL). Public links are share links on the agent-fs host (AGENT_FS_PUBLIC_URL).
    cat <<EOF
# onboarding-qa stack: agent-fs keeps files on its own volume (/data/storage), so
# MinIO does not run and Caddy has no MinIO route. Tag telemetry from first boot.
services:
  agent-fs:
    depends_on: !reset {}
    environment:
      AGENT_FS_STORAGE_PROVIDER: local
      AGENT_FS_LOCAL_ROOT: /data/storage
      AGENT_FS_PUBLIC_URL: https://$fs_host
      AGENT_FS_APP_URL: https://app.agent-swarm.dev
EOF
  else
    cat <<'EOF'
# onboarding-qa stack: the example's MinIO login (minioadmin) is public through
# Caddy at /agentfs/*, so use a generated one. Tag telemetry from first boot.
services:
  minio:
    environment:
      MINIO_ROOT_USER: agentfs
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?}
  minio-init:
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 agentfs $${MINIO_ROOT_PASSWORD} &&
      mc mb --ignore-existing local/agentfs &&
      mc version enable local/agentfs
      "
    environment:
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?}
  agent-fs:
    environment:
      S3_ACCESS_KEY_ID: agentfs
      S3_SECRET_ACCESS_KEY: ${MINIO_ROOT_PASSWORD:?}
EOF
  fi
  for svc in api $agents; do
    printf '  %s:\n    environment:\n      DESPLEGA_TELEMETRY_ENV: %s\n' "$svc" "$telemetry"
  done
  if [ "$fs_storage" = local ]; then
    cat <<EOF
configs:
  caddyfile:
    content: |
      $api_host {
        reverse_proxy api:3013
      }
      $fs_host {
        reverse_proxy agent-fs:7433
      }
EOF
  fi
} >docker-compose.override.yml
chmod 600 .env encryption_key
known="$(docker compose --profile tls config --services)"
for svc in $agents; do
  grep -qx "$svc" <<<"$known" || { echo "no service '$svc' in docker-compose.example.yml at $ref" >&2; exit 2; }
done
# Services to start: the storage, the API, the agents, Caddy, and what the overlays add.
base="$(docker compose -f docker-compose.yml -f docker-compose.override.yml --profile tls config --services)"
added="$(grep -vxFf <(printf '%s\n' "$base") <<<"$known" | tr '\n' ' ' || true)"
storage="minio minio-init"
[ "$fs_storage" = local ] && storage=""
echo "$storage agent-fs api $agents caddy $added" | tr -s ' ' >up-services
echo "stack files ready in /root/swarm ($image_tag, Compose files from $ref)"
REMOTE

  [ ${#keys[@]} -eq 0 ] || bash "$here/secrets.sh" push-env "$run" /root/swarm/.env "${keys[@]}"

  echo "starting: $(ssh -F "$dir/ssh_config" box 'cat ~/swarm/up-services') ($(bcn) BCN). The first pull takes 2-4 min"
  # up-services holds validated service names only (written above).
  ssh -F "$dir/ssh_config" box 'cd ~/swarm && docker compose --profile tls up -d --quiet-pull $(cat up-services)' \
    >"$dir/stack-up.log" 2>&1 || { tail -20 "$dir/stack-up.log" >&2; exit 1; }

  # --resolve skips the local resolver: it can cache the old wildcard answer for minutes.
  local host ok=""
  for _ in $(seq 1 60); do
    ok=1
    for host in "$api_host" "$fs_host"; do
      curl -fsS -m 10 -o /dev/null --resolve "$host:443:$ip" "https://$host/health" 2>/dev/null || ok=""
    done
    [ -n "$ok" ] && break
    sleep 5
  done
  [ -n "$ok" ] || { echo "HTTPS not ready after 5 min. Check: ssh -F $dir/ssh_config box 'cd ~/swarm && docker compose logs caddy'" >&2; exit 1; }
  echo "https ok: $api_host, $fs_host ($(bcn) BCN)"

  local want count=0
  want="$(wc -w <<<"$agents" | tr -d ' ')"
  for _ in $(seq 1 36); do
    count="$(api GET /api/agents | jq '(.agents // .) | length' 2>/dev/null || echo 0)"
    [ "$count" -ge "$want" ] && break
    sleep 5
  done
  api GET /api/agents | jq -r '(.agents // .)[] | "  \(.name)\tlead=\(.isLead)\t\(.status)"'
  [ "$count" -ge "$want" ] || echo "only $count of $want agents registered after 3 min" >&2

  local key
  key="$(ssh -F "$dir/ssh_config" box "grep -E '^API_KEY=' ~/swarm/.env | cut -d= -f2")"
  (umask 077 && printf '%s/setup?apiUrl=%s&apiKey=%s\n' "$DASHBOARD" \
    "$(jq -rn --arg u "https://$api_host" '$u | @uri')" "$key" >"$dir/setup-url")
  {
    grep -vE '^(STACK_API|STACK_FS|VERSION|REF|OVERLAYS|FS_STORAGE)=' "$dir/run.env" || true
    echo "STACK_API=$api_host"
    echo "STACK_FS=$fs_host"
    echo "VERSION=$image_tag"
    echo "REF=$ref"
    echo "OVERLAYS=$overlays"
    echo "FS_STORAGE=$fs_storage"
  } >"$dir/run.env.tmp" && mv "$dir/run.env.tmp" "$dir/run.env"
  echo "ready $image_tag (Compose files from $ref) in $(($(date +%s) - started))s ($(bcn) BCN)"
  echo "  api:       https://$api_host"
  echo "  agent-fs:  https://$fs_host"
  echo "  dashboard: $dir/setup-url (API key inside). Open: secrets.sh open-setup $run"
  echo "  ssh:       ssh -F $dir/ssh_config box   (stack in /root/swarm)"
  echo "  teardown:  stack.sh down $run"
}

cmd_smoke() {
  local secs="${1:-240}" agents worker body id task="{}" status=""
  [[ "$secs" =~ ^[0-9]+$ ]] || usage
  agents="$(api GET /api/agents)"
  worker="$(jq -r '(.agents // .) | (map(select(.isLead | not)) + .)[0].id // empty' <<<"$agents")"
  [ -n "$worker" ] || { echo "no agent registered" >&2; exit 1; }
  body="$(jq -nc --arg a "$worker" '{
    task: "Smoke test for a new deployment. Write a file demo/hello.md to your agent-fs drive with the text: hello from the smoke test. Then reply with the agent-fs path you wrote and nothing else.",
    agentId: $a, routingReason: "human_pinned", modelTier: "smol", tags: ["smoke"]}')"
  id="$(api POST /api/tasks "$body" | jq -r '.id // .task.id // empty')"
  [ -n "$id" ] || { echo "task create failed" >&2; exit 1; }
  echo "smoke task $id sent to $(jq -r --arg a "$worker" '(.agents // .)[] | select(.id == $a) | .name' <<<"$agents") ($(bcn) BCN)"
  for _ in $(seq 1 $((secs / 5))); do
    task="$(api GET "/api/tasks/$id")"
    status="$(jq -r '.status' <<<"$task")"
    case "$status" in completed | failed | cancelled) break ;; esac
    sleep 5
  done
  echo "status: $status ($(bcn) BCN)"
  jq -r '.output // .failureReason // "(no output yet)"' <<<"$task" | head -c 600
  echo
  [ "$status" = completed ]
}

cmd_down() {
  dns_rm
  bash "$here/box.sh" down "$run"
}

run="${2:-}"
[[ "$run" =~ ^[a-z0-9][a-z0-9-]{2,40}$ ]] || usage
dir="/tmp/onboarding-qa-$run"
case "${1:-}" in
  up) shift 2; cmd_up "$@" ;;
  smoke) cmd_smoke "${3:-}" ;;
  down) cmd_down ;;
  *) usage ;;
esac
