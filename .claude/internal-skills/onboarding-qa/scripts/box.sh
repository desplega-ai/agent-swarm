#!/usr/bin/env bash
# Throwaway Hetzner box for onboarding QA. One box per run id.
#
#   box.sh up <run> [image]   create the box (default image ubuntu-24.04), wait for SSH
#   box.sh ip <run>           print the box IPv4
#   box.sh down <run>         delete the box and its firewall (keeps the local run dir)
#   box.sh list               list every onboarding-qa box
#   box.sh reap [hours]       delete onboarding-qa boxes older than <hours> (default 6), except keep=true
#
# After `up`, reach the box with `ssh -F /tmp/onboarding-qa-<run>/ssh_config box`
# (root) or `... box-user` (the sudo user "alex").
#
# ONBOARDING_QA_FIREWALL=web adds a Hetzner firewall that allows only 22, 80, 443 and ICMP
# (stack mode: Compose publishes MinIO, agent-fs and the API on the host). Default: no firewall,
# like a fresh VPS. ONBOARDING_QA_KEEP=1 labels the box keep=true, so reap skips it.
set -euo pipefail

CTX="${ONBOARDING_QA_HCLOUD_CONTEXT:-taras}"
SSH_KEY="${ONBOARDING_QA_SSH_KEY:-taras}"
PUBKEY_FILE="${ONBOARDING_QA_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
IDENTITY_FILE="${PUBKEY_FILE%.pub}"
# Comma lists, tried in order: the first type with stock in one of the locations wins
# (Hetzner often runs out of the cx line).
TYPES="${ONBOARDING_QA_SERVER_TYPE:-cx33,cpx32}"
LOCATIONS="${ONBOARDING_QA_LOCATION:-fsn1,nbg1,hel1}"
FIREWALL="${ONBOARDING_QA_FIREWALL:-}"
KEEP="${ONBOARDING_QA_KEEP:-}"
QA_USER="alex"

hc() { hcloud --context "$CTX" "$@"; }

check_run() {
  [[ "${1:-}" =~ ^[a-z0-9][a-z0-9-]{2,40}$ ]] || {
    echo "run id must match ^[a-z0-9][a-z0-9-]{2,40}\$ (got '${1:-}')" >&2
    exit 2
  }
}

# Prints "<type> <location>" for the first type in TYPES with stock in a location in LOCATIONS.
pick_placement() {
  local t l info
  for t in ${TYPES//,/ }; do
    info="$(hc server-type describe "$t" -o json 2>/dev/null)" || continue
    for l in ${LOCATIONS//,/ }; do
      if jq -e --arg l "$l" '.locations[]? | select(.name == $l and .available)' <<<"$info" >/dev/null; then
        echo "$t $l"
        return 0
      fi
    done
  done
  return 1
}

run_dir() { echo "/tmp/onboarding-qa-$1"; }
server_name() { echo "onb-qa-$1"; }

cmd_up() {
  local run="$1" image="${2:-ubuntu-24.04}"
  local dir name pubkey ip placement TYPE LOCATION
  placement="$(pick_placement)" || { echo "no stock for types $TYPES in $LOCATIONS" >&2; exit 1; }
  TYPE="${placement% *}" LOCATION="${placement#* }"
  dir="$(run_dir "$run")"
  name="$(server_name "$run")"
  pubkey="$(cat "$PUBKEY_FILE")"
  mkdir -p "$dir/turns" && chmod 700 "$dir"

  # A plain sudo user next to root. Nothing else: the box must look like a
  # fresh VPS, so the install under test meets every missing prerequisite.
  cat >"$dir/cloud-init.yaml" <<EOF
#cloud-config
users:
  - default
  - name: $QA_USER
    shell: /bin/bash
    groups: [sudo]
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - $pubkey
runcmd:
  - [sh, -c, "getent group docker && usermod -aG docker $QA_USER || true"]
EOF

  local extra=()
  [ -n "$KEEP" ] && extra+=(--label keep=true)
  case "$FIREWALL" in
    "") ;;
    web)
      cat >"$dir/firewall.json" <<'EOF'
[
  {"direction": "in", "protocol": "tcp", "port": "22", "source_ips": ["0.0.0.0/0", "::/0"], "description": "ssh"},
  {"direction": "in", "protocol": "tcp", "port": "80", "source_ips": ["0.0.0.0/0", "::/0"], "description": "http (ACME)"},
  {"direction": "in", "protocol": "tcp", "port": "443", "source_ips": ["0.0.0.0/0", "::/0"], "description": "https"},
  {"direction": "in", "protocol": "udp", "port": "443", "source_ips": ["0.0.0.0/0", "::/0"], "description": "http3"},
  {"direction": "in", "protocol": "icmp", "source_ips": ["0.0.0.0/0", "::/0"], "description": "ping"}
]
EOF
      hc firewall create --name "$name" --rules-file "$dir/firewall.json" \
        --label purpose=onboarding-qa --label "run=$run" >/dev/null
      extra+=(--firewall "$name")
      ;;
    *) echo "ONBOARDING_QA_FIREWALL must be empty or 'web' (got '$FIREWALL')" >&2; exit 2 ;;
  esac

  if ! hc server create --name "$name" --type "$TYPE" --location "$LOCATION" --image "$image" \
    --ssh-key "$SSH_KEY" --user-data-from-file "$dir/cloud-init.yaml" \
    --label purpose=onboarding-qa --label "run=$run" "${extra[@]}" >/dev/null; then
    [ -n "$FIREWALL" ] && delete_firewall "$name"
    echo "server create failed ($TYPE in $LOCATION). On resource_unavailable, run again: stock changes fast" >&2
    exit 1
  fi
  ip="$(hc server ip "$name")"

  cat >"$dir/ssh_config" <<EOF
Host box box-user
  HostName $ip
  IdentityFile $IDENTITY_FILE
  IdentitiesOnly yes
  UserKnownHostsFile $dir/known_hosts
  StrictHostKeyChecking accept-new
  ConnectTimeout 10
  ServerAliveInterval 30
Host box
  User root
Host box-user
  User $QA_USER
EOF
  {
    echo "RUN=$run"
    echo "IMAGE=$image"
    echo "IP=$ip"
  } >"$dir/run.env"

  for _ in $(seq 1 36); do
    if ssh -F "$dir/ssh_config" box 'cloud-init status --wait >/dev/null 2>&1; true' 2>/dev/null &&
      ssh -F "$dir/ssh_config" box-user true 2>/dev/null; then
      echo "box $name up: $ip ($TYPE, $image, $LOCATION, context $CTX${FIREWALL:+, firewall $FIREWALL}${KEEP:+, keep})"
      echo "ssh: ssh -F $dir/ssh_config box | box-user"
      return 0
    fi
    sleep 5
  done
  echo "box $name created ($ip) but SSH is not ready after 3 min" >&2
  exit 1
}

cmd_ip() { hc server ip "$(server_name "$1")"; }

delete_firewall() {
  # A firewall can only go once no server uses it, so call this after the server delete.
  if hc firewall describe "$1" >/dev/null 2>&1; then
    hc firewall delete "$1" >/dev/null
    echo "deleted firewall $1"
  fi
}

cmd_down() {
  local name
  name="$(server_name "$1")"
  if hc server describe "$name" >/dev/null 2>&1; then
    hc server delete "$name" >/dev/null
    echo "deleted $name"
  else
    echo "no server $name"
  fi
  delete_firewall "$name"
  echo "local run dir kept: $(run_dir "$1")"
}

cmd_list() {
  hc server list -l purpose=onboarding-qa -o columns=name,status,type,ipv4,age,labels
  hc firewall list -l purpose=onboarding-qa -o columns=name,age
}

cmd_reap() {
  local hours="${1:-6}" cutoff
  [[ "$hours" =~ ^[0-9]+$ ]] || { echo "hours must be an integer" >&2; exit 2; }
  cutoff=$(($(date +%s) - hours * 3600))
  hc server list -l purpose=onboarding-qa -o json |
    jq -r --argjson cutoff "$cutoff" \
      '.[] | select(.labels.keep != "true")
        | select((.created | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601) < $cutoff) | .name' |
    while read -r server; do
      hc server delete "$server"
      echo "reaped $server"
    done
  # Firewalls left behind by a server delete outside box.sh down.
  hc firewall list -l purpose=onboarding-qa -o json | jq -r '.[] | select((.applied_to | length) == 0) | .name' |
    while read -r fw; do delete_firewall "$fw"; done
}

case "${1:-}" in
  up) check_run "${2:-}"; cmd_up "$2" "${3:-}" ;;
  ip) check_run "${2:-}"; cmd_ip "$2" ;;
  down) check_run "${2:-}"; cmd_down "$2" ;;
  list) cmd_list ;;
  reap) cmd_reap "${2:-}" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
