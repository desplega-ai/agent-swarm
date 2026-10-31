#!/usr/bin/env bash
# Agent Swarm one-shot self-host installer.
#
#   curl -fsSL https://agent-swarm.dev/install.sh | bash
#   curl -fsSL https://agent-swarm.dev/install.sh | bash -s -- --no-tunnel
#   bash install.sh --public-url https://swarm.example.com --bind 127.0.0.1   # behind a reverse proxy
#
# The raw GitHub URL (https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/install.sh)
# serves the same script. The API goes public through a localtunnel by default
# (see --tunnel / --no-tunnel); the API key still protects every route but /health.
#
# It checks Docker and Compose v2, installs Bun when missing, runs
# `agent-swarm onboard --yes --preset full` (a lead and 10 workers) to write
# and start a Docker Compose stack, waits
# for the API, and prints a dashboard link to /setup, where the rest of the
# configuration (harness credentials, integrations) happens.
#
# Everything lives in main(), called on the last line, so bash reads the whole
# file before running anything. That keeps a truncated `curl | bash` download
# from executing half a script, and stops child processes from reading the
# rest of the script off stdin.

set -euo pipefail

DEFAULT_DIR="${HOME}/agent-swarm"
DEFAULT_PRESET="full"
DEFAULT_CLI_VERSION="latest"
DEFAULT_LT_VERSION="2.2.0"
DASHBOARD_BASE="https://app.agent-swarm.dev"
DOCKER_INSTALL_URL="https://docs.docker.com/get-started/get-docker/"
COMPOSE_INSTALL_URL="https://docs.docker.com/compose/install/"
BUN_INSTALL_URL="https://bun.sh/install"
HEALTH_TIMEOUT_SECONDS=180
TUNNEL_WARMUP_SECONDS=240

DRY_RUN=0
# auto (default) | 1 | 0. AGENT_SWARM_TUNNEL=1|0 overrides auto; flags override env.
TUNNEL=auto
case "${AGENT_SWARM_TUNNEL:-}" in
  1 | true | on) TUNNEL=1 ;;
  0 | false | off) TUNNEL=0 ;;
esac
TUNNEL_FLAG=0
NO_AGENT_FS=0
PUBLIC_URL="${AGENT_SWARM_PUBLIC_URL:-}"
BIND_ADDRESS="${AGENT_SWARM_BIND_ADDRESS:-}"
INSTALL_DIR="${AGENT_SWARM_DIR:-$DEFAULT_DIR}"
PRESET="${AGENT_SWARM_PRESET:-$DEFAULT_PRESET}"
CLI_VERSION="${AGENT_SWARM_CLI_VERSION:-$DEFAULT_CLI_VERSION}"
LT_VERSION="${AGENT_SWARM_LT_VERSION:-$DEFAULT_LT_VERSION}"
# 1 from just before the first `docker compose up` under --bind until
# assert_ports_bound passes. While it is 1, on_exit stops the stack.
PORTS_UNCHECKED=0
CLI_PACKAGE="${AGENT_SWARM_CLI_PACKAGE:-}"

usage() {
  cat <<EOF
Agent Swarm installer: one command from zero to a running self-hosted swarm.

Usage:
  curl -fsSL https://agent-swarm.dev/install.sh | bash
  curl -fsSL https://agent-swarm.dev/install.sh | bash -s -- [options]
  bash install.sh [options]

Options:
  --dir <path>       Install directory (default: \$AGENT_SWARM_DIR, else ~/agent-swarm)
  --version <ver>    @desplega.ai/agent-swarm npm version to run (default: latest)
  --tunnel           Force the public tunnel on (localtunnel, lt.desplega.ai). It sets
                     PUBLIC_MCP_BASE_URL. This is already the default. See "Tunnel".
  --no-tunnel        Keep the API local only. No tunnel, no PUBLIC_MCP_BASE_URL.
  --public-url <url> The API's public address behind your own reverse proxy, e.g.
                     https://swarm.example.com. Sets PUBLIC_MCP_BASE_URL, implies
                     --no-tunnel, and the dashboard link uses it.
  --bind <addr>      Publish the API and agent ports on this host address only, e.g.
                     127.0.0.1 behind a reverse proxy (saved as AGENT_SWARM_BIND_ADDRESS
                     in .env). Docker-published ports bypass host firewalls such as ufw.
                     Before the first start, docker-compose.override.yml sets it as the
                     default host address of the stack's Docker network.
                     An older docker-compose.yml gets its port mappings rewritten (backup
                     in docker-compose.yml.bak). Fails, stopping the stack, if a running
                     port still listens elsewhere, or if the install fails before that check.
  --no-agent-fs      Skip the bundled agent-fs (files, Comb) and TEI (memory
                     embeddings) services. New installs only.
  --dry-run          Print every command instead of running it
  -h, --help         Show this help

Environment:
  AGENT_SWARM_DIR          Same as --dir
  AGENT_SWARM_CLI_VERSION  Same as --version
  AGENT_SWARM_CLI_PACKAGE  Full package spec for the CLI instead of the npm release:
                           a tarball path or URL from \`bun pm pack\` (testing unreleased builds)
  AGENT_SWARM_TUNNEL       1 forces the tunnel on, 0 forces it off (flags win over this)
  AGENT_SWARM_PUBLIC_URL   Same as --public-url
  AGENT_SWARM_BIND_ADDRESS Same as --bind
  AGENT_SWARM_LT_VERSION   @desplega.ai/localtunnel version for --tunnel (default: ${DEFAULT_LT_VERSION})
  ANONYMIZED_TELEMETRY, DESPLEGA_TELEMETRY_ENV
                           Written to .env: turn telemetry off, or set the cohort tag
  CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY,
  HARNESS_PROVIDER, GITHUB_TOKEN, SLACK_BOT_TOKEN, ...
                           Passed through to \`agent-swarm onboard --yes\`. All optional:
                           without a harness credential the workers start and wait
                           until you add one on the dashboard /setup page.

What it does:
  1. Checks for Docker and Docker Compose v2 (exits with an install link if missing).
  2. Installs Bun from ${BUN_INSTALL_URL} if bun is not on PATH.
  3. Runs \`bunx @desplega.ai/agent-swarm@<version> onboard --yes --preset full\`
     in the install directory: a lead and 10 workers, plus agent-fs (files on local
     disk, read in the dashboard's Comb) and TEI (local memory embeddings), unless
     --no-agent-fs. That writes docker-compose.yml and .env and runs
     \`docker compose up -d\`. If docker-compose.yml already exists, it skips
     onboarding and only runs \`docker compose up -d\`, so an existing install
     keeps its services.
  4. Waits for http://localhost:<port>/health.
  5. Prints the dashboard link to /setup with the API URL and key filled in. The
     link uses the public URL (tunnel, --public-url, or PUBLIC_MCP_BASE_URL in .env)
     when there is one, else http://localhost:<port>.

Tunnel (on by default, --no-tunnel turns it off):
  The tunnel is on unless you pass --no-tunnel (or AGENT_SWARM_TUNNEL=0), or the
  install directory's .env already has a PUBLIC_MCP_BASE_URL that is not a
  *.lt.desplega.ai URL (your own domain). A previous tunnel URL keeps it on.
  An explicit choice is saved as AGENT_SWARM_TUNNEL=1|0 in .env, so a re-run
  without flags keeps it.
  Runs \`lt --port <port>\` in the background (pid in .agent-swarm/tunnel.pid, log in
  .agent-swarm/tunnel.log), writes the public URL to PUBLIC_MCP_BASE_URL in .env,
  adds docker-compose.override.yml to pass it to the API, restarts the API (and
  agent-fs, when the stack has it) and sends warm-up requests (the first request through a fresh tunnel can hang).
  The URL is random and changes whenever the tunnel restarts, including after a
  reboot. Anyone with the URL can reach your API; every route except /health
  still needs the API key. Re-running with --tunnel replaces the tunnel. Stop it:
    pkill -P "\$(cat .agent-swarm/tunnel.pid)"; kill "\$(cat .agent-swarm/tunnel.pid)"

Examples:
  curl -fsSL .../install.sh | bash
  curl -fsSL .../install.sh | ANTHROPIC_API_KEY=sk-ant-... bash
  bash install.sh --dry-run --no-tunnel
  bash install.sh --dry-run --tunnel
  bash install.sh --dry-run --public-url https://swarm.example.com --bind 127.0.0.1
EOF
}

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# Print a command with shell quoting, then run it unless --dry-run.
run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [ "$DRY_RUN" -eq 1 ]; then return 0; fi
  "$@"
}

have() { command -v "$1" >/dev/null 2>&1; }

# The install command for a package on this host's package manager.
install_hint() {
  local sudo=""
  [ "$(id -u)" -eq 0 ] || sudo="sudo "
  if have apt-get; then echo "${sudo}apt-get update && ${sudo}apt-get install -y $1"
  elif have dnf; then echo "${sudo}dnf install -y $1"
  elif have yum; then echo "${sudo}yum install -y $1"
  elif have apk; then echo "${sudo}apk add $1"
  elif have pacman; then echo "${sudo}pacman -S --noconfirm $1"
  elif have brew; then echo "brew install $1"
  else echo "install $1 with your package manager"
  fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) [ $# -ge 2 ] || die "--dir needs a value"; INSTALL_DIR="$2"; shift 2 ;;
      --dir=*) INSTALL_DIR="${1#*=}"; shift ;;
      # Not in --help: the installer offers one stack (full). The flag stays so
      # existing `--preset full` commands keep working, and for testing.
      --preset) [ $# -ge 2 ] || die "--preset needs a value"; PRESET="$2"; shift 2 ;;
      --preset=*) PRESET="${1#*=}"; shift ;;
      --version) [ $# -ge 2 ] || die "--version needs a value"; CLI_VERSION="$2"; shift 2 ;;
      --version=*) CLI_VERSION="${1#*=}"; shift ;;
      --tunnel) TUNNEL=1; TUNNEL_FLAG=1; shift ;;
      --no-tunnel) TUNNEL=0; shift ;;
      --public-url) [ $# -ge 2 ] || die "--public-url needs a value"; PUBLIC_URL="$2"; shift 2 ;;
      --public-url=*) PUBLIC_URL="${1#*=}"; shift ;;
      --bind) [ $# -ge 2 ] || die "--bind needs a value"; BIND_ADDRESS="$2"; shift 2 ;;
      --bind=*) BIND_ADDRESS="${1#*=}"; shift ;;
      --no-agent-fs) NO_AGENT_FS=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
  case "$PRESET" in
    solo | dev | content | research | full) ;;
    *) die "invalid preset '$PRESET'. Options: solo, dev, content, research, full" ;;
  esac
  if [ -n "$PUBLIC_URL" ]; then
    case "$PUBLIC_URL" in
      http://?* | https://?*) PUBLIC_URL="${PUBLIC_URL%/}" ;;
      *) die "--public-url must start with http:// or https:// (got '$PUBLIC_URL')" ;;
    esac
    [ "$TUNNEL_FLAG" -eq 1 ] && die "--public-url and --tunnel conflict: the tunnel sets its own public URL"
    TUNNEL=0
  fi
  case "$BIND_ADDRESS" in
    *[!0-9a-fA-F.:]*) die "--bind needs an IP address, e.g. 127.0.0.1 (got '$BIND_ADDRESS')" ;;
  esac
}

# A missing prerequisite is fatal, except under --dry-run, where it is a
# warning so the rest of the plan can still be printed.
missing() {
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "$* (continuing because of --dry-run)"
  else
    die "$*"
  fi
}

check_docker() {
  if ! have docker; then
    missing "Docker is not installed. Install it from ${DOCKER_INSTALL_URL}"
    return 0
  fi
  if ! docker compose version >/dev/null 2>&1; then
    missing "Docker Compose v2 (\`docker compose\`) is not available. Install it from ${COMPOSE_INSTALL_URL}"
    return 0
  fi
  if ! docker info >/dev/null 2>&1; then
    missing "Docker is installed but the daemon is not reachable. Start Docker (or add your user to the docker group) and retry."
    return 0
  fi
  say "Docker and Compose v2 found"
}

ensure_bun() {
  # A previous run installed Bun but a fresh non-login shell lacks it on PATH.
  if ! have bun && [ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]; then
    export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
  fi
  if have bun; then
    say "Bun found: $(bun --version)"
    return 0
  fi
  # The onboard CLI uses Bun APIs, so Node alone cannot run it.
  say "Bun not found; installing from ${BUN_INSTALL_URL}"
  # The Bun installer unzips its download, and some server images lack unzip.
  if ! have unzip; then
    missing "unzip is required to install Bun. Install it, then retry: $(install_hint unzip)"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ curl -fsSL %s | bash\n' "$BUN_INSTALL_URL"
  else
    curl -fsSL "$BUN_INSTALL_URL" | bash
  fi
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if [ "$DRY_RUN" -eq 0 ] && ! have bun; then
    die "Bun install finished but bun is not on PATH. Open a new shell and retry."
  fi
}

compose_up() {
  run docker compose --env-file .env up -d "$@" </dev/null
}

onboard() {
  if [ -f "${INSTALL_DIR}/docker-compose.yml" ]; then
    say "docker-compose.yml already exists in ${INSTALL_DIR}; skipping onboard and starting the stack"
    if [ -n "$BIND_ADDRESS" ]; then bind_compose_ports || true; fi
    compose_up
    return 0
  fi
  local spec="${CLI_PACKAGE:-@desplega.ai/agent-swarm@${CLI_VERSION}}"
  local extra=()
  [ "$NO_AGENT_FS" -eq 1 ] && extra+=(--no-agent-fs)
  say "Running agent-swarm onboard (preset: ${PRESET}, cli: ${spec})"
  run bunx --package "$spec" agent-swarm onboard --yes --preset "$PRESET" \
    --container-engine docker ${extra[@]+"${extra[@]}"} </dev/null
}

# What the onboard compose generator puts before each published port
# (src/commands/onboard/compose-generator.ts): "<address>:" when
# AGENT_SWARM_BIND_ADDRESS is set, nothing otherwise.
# shellcheck disable=SC2016 # Compose expands this, not the shell
BIND_PREFIX='${AGENT_SWARM_BIND_ADDRESS:+${AGENT_SWARM_BIND_ADDRESS:-}:}'

# A docker-compose.yml from a CLI release before AGENT_SWARM_BIND_ADDRESS
# publishes "3013:3013" on every interface. Give each such mapping the bind
# prefix, keeping a backup. A mapping with its own host address, or one this
# cannot read, is a hard error. Returns 0 when it rewrote the file.
bind_compose_ports() {
  local file="${INSTALL_DIR}/docker-compose.yml" tmp result
  if [ ! -f "$file" ]; then
    [ "$DRY_RUN" -eq 1 ] && printf '+ rewrite port mappings in docker-compose.yml to honour --bind\n'
    return 1
  fi
  tmp="$(mktemp)"
  result="$(awk -v prefix="$BIND_PREFIX" -v addr="$BIND_ADDRESS" -v out="$tmp" '
    function emit(line) { print line > out }
    /^ *ports: *$/ { inports = 1; emit($0); next }
    inports && /^ *- / {
      entry = $0
      sub(/^ *- */, "", entry)
      gsub(/["\047]/, "", entry)
      if (entry ~ /^[0-9]+(-[0-9]+)?:[0-9]+(-[0-9]+)?(\/(tcp|udp))?$/) {
        indent = $0
        sub(/-.*$/, "", indent)
        emit(indent "- \"" prefix entry "\"")
        changed++
        next
      }
      if (index(entry, prefix) != 1 && index(entry, addr ":") != 1 && index(entry, "[" addr "]:") != 1) bad = bad " " entry
      emit($0)
      next
    }
    { inports = 0; emit($0) }
    END { printf "%d%s", changed, bad }
  ' "$file")"
  case "$result" in
    0) rm -f "$tmp"; return 1 ;;
    *" "*)
      rm -f "$tmp"
      die "docker-compose.yml publishes ports that ignore --bind: ${result#* }. Change them to ${BIND_PREFIX}<host>:<container>, or run without --bind."
      ;;
  esac
  say "Rewriting ${result} port mapping(s) in docker-compose.yml to publish on ${BIND_ADDRESS} (backup: docker-compose.yml.bak)"
  if [ "$DRY_RUN" -eq 1 ]; then
    rm -f "$tmp"
  else
    { cp "$file" "${file}.bak" && cat "$tmp" >"$file"; } || die "could not rewrite ${file}"
    rm -f "$tmp"
  fi
}

OVERRIDE_FILE=docker-compose.override.yml
BINDING_OPTION=com.docker.network.bridge.host_binding_ipv4

# Start docker-compose.override.yml with its header, unless it exists.
start_override() {
  local file="${INSTALL_DIR}/${OVERRIDE_FILE}"
  [ ! -f "$file" ] || return 0
  printf '%s\n' "# Written by install.sh. Compose merges this file into docker-compose.yml automatically." >"$file"
}

# Compose publishes a port without a host address on its project network's
# default address: 0.0.0.0 unless the network sets $BINDING_OPTION (it takes
# IPv6 too). dockerd's "ip" setting covers only its own default bridge. This
# runs before onboard, so even the first `up` of a CLI that ignores
# AGENT_SWARM_BIND_ADDRESS binds there. Compose loads only the first override
# file it finds, so a compose.override.* would hide this one.
bind_network_default() {
  local file="${INSTALL_DIR}/${OVERRIDE_FILE}" f tmp
  for f in compose.override.yml compose.override.yaml; do
    [ ! -e "${INSTALL_DIR}/${f}" ] ||
      die "${f} hides ${OVERRIDE_FILE} from Compose, so --bind cannot set the network's default address. Merge it into ${OVERRIDE_FILE}, then run again."
  done
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ set the default network'"'"'s %s=%s in %s\n' "$BINDING_OPTION" "$BIND_ADDRESS" "$OVERRIDE_FILE"
    return 0
  fi
  if [ -f "$file" ] && grep -qF "$BINDING_OPTION" "$file"; then
    tmp="$(mktemp)"
    sed -E "s/(${BINDING_OPTION//./\\.}:).*/\\1 \"${BIND_ADDRESS}\"/" "$file" >"$tmp"
    cat "$tmp" >"$file"
    rm -f "$tmp"
    return 0
  fi
  if [ -f "$file" ] && grep -qE '^networks:' "$file"; then
    die "${OVERRIDE_FILE} already has a networks: section. Add driver_opts: { ${BINDING_OPTION}: \"${BIND_ADDRESS}\" } to its default network, then run again."
  fi
  start_override
  cat >>"$file" <<YAML
networks:
  default:
    driver_opts:
      ${BINDING_OPTION}: "${BIND_ADDRESS}"
YAML
}

# Compose reuses an existing network without applying new driver options (it
# only recreates one it labelled with a config hash, from Compose 2.31). A
# network left by an earlier install in a directory with this name would keep
# publishing on every interface, so a fresh install refuses it.
check_project_network() {
  local project net current
  [ "$DRY_RUN" -eq 0 ] || return 0
  # Compose's default project name: the directory name, lowercased, keeping
  # [a-z0-9_-], without leading "_" or "-".
  project="$(printf '%s' "${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  project="${project#"${project%%[a-z0-9]*}"}"
  net="${project}_default"
  docker network inspect "$net" >/dev/null 2>&1 </dev/null || return 0
  current="$(docker network inspect --format "{{index .Options \"${BINDING_OPTION}\"}}" "$net" </dev/null || true)"
  [ "$current" = "$BIND_ADDRESS" ] ||
    die "Docker network ${net} from an earlier install exists and publishes ports on ${current:-every interface}. Remove it (stop its containers, then: docker network rm ${net}) and run again."
}

# Check the running stack, not the files: every published port must listen on
# --bind. Otherwise stop the stack and fail, so no port stays public by mistake.
assert_ports_bound() {
  local exposed
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ check that every published port listens on %s\n' "$BIND_ADDRESS"
    return 0
  fi
  exposed="$(docker compose ps --format '{{.Ports}}' </dev/null | tr ',' '\n' | grep -- '->' |
    sed -E 's/^ +//' | awk -v a="${BIND_ADDRESS}:" -v b="[${BIND_ADDRESS}]:" \
      'index($0, a) != 1 && index($0, b) != 1' || true)"
  if [ -n "$exposed" ]; then
    docker compose stop </dev/null || true
    PORTS_UNCHECKED=0
    die "ports are still published outside ${BIND_ADDRESS} ($(echo "$exposed" | tr '\n' ' ')), so the stack was stopped. Check the ports: sections of docker-compose.yml and any override file."
  fi
  say "Publishing ports on ${BIND_ADDRESS} only"
}

# EXIT trap under --bind. A CLI release before AGENT_SWARM_BIND_ADDRESS starts
# the stack inside onboard with ports on every interface, so any exit before
# assert_ports_bound passes (a failed onboard, a hard error, Ctrl-C) stops it.
on_exit() {
  local code=$?
  if [ "$PORTS_UNCHECKED" -eq 1 ] &&
    (cd "$INSTALL_DIR" && docker compose stop </dev/null >/dev/null 2>&1); then
    warn "stopped the stack: its ports were not confirmed on ${BIND_ADDRESS}"
  fi
  exit "$code"
}

# Whether the stack runs the bundled agent-fs service. A dry run writes no
# docker-compose.yml, so it assumes what onboard would have generated.
has_agent_fs_service() {
  local file="${INSTALL_DIR}/docker-compose.yml"
  if [ -f "$file" ]; then
    grep -qE '^  agent-fs:$' "$file"
  else
    [ "$DRY_RUN" -eq 1 ] && [ "$NO_AGENT_FS" -eq 0 ]
  fi
}

# Read KEY=value from .env (last match wins, like Compose).
env_value() {
  local file="${INSTALL_DIR}/.env"
  [ -f "$file" ] || return 0
  grep -E "^$1=" "$file" | tail -n 1 | cut -d= -f2- || true
}

# Decide whether to open the tunnel. An explicit --tunnel / --no-tunnel /
# AGENT_SWARM_TUNNEL wins and is saved to .env as AGENT_SWARM_TUNNEL, so a later
# re-run keeps the choice. In auto mode, a saved AGENT_SWARM_TUNNEL wins. Without
# one, the tunnel is on unless .env holds a PUBLIC_MCP_BASE_URL that is not a
# tunnel URL (the user's own domain).
resolve_tunnel() {
  local saved existing
  if [ "$TUNNEL" = auto ]; then
    saved="$(env_value AGENT_SWARM_TUNNEL)"
    existing="$(env_value PUBLIC_MCP_BASE_URL)"
    if [ "$saved" = 0 ]; then
      TUNNEL=0
      say "Keeping the API local (AGENT_SWARM_TUNNEL=0 in .env)."
      return 0
    elif [ "$saved" = 1 ]; then
      TUNNEL=1
    else
      case "$existing" in
        "" | https://*.lt.desplega.ai | https://*.lt.desplega.ai/*) TUNNEL=1 ;;
        *)
          TUNNEL=0
          say "Keeping PUBLIC_MCP_BASE_URL=${existing} from .env, so no tunnel."
          return 0
          ;;
      esac
    fi
    say "The API will be public through a tunnel (lt.desplega.ai). The API key protects it. Pass --no-tunnel to keep it local."
  else
    set_env_value AGENT_SWARM_TUNNEL "$TUNNEL"
  fi
}

# Set KEY=value in .env, replacing an existing line or appending one.
set_env_value() {
  local key="$1" val="$2" file="${INSTALL_DIR}/.env" tmp
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ set %s=%s in %s\n' "$key" "$val" "$file"
    return 0
  fi
  tmp="$(mktemp)"
  if [ -f "$file" ]; then grep -vE "^${key}=" "$file" >"$tmp" || true; fi
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file"
}

api_port() {
  local base port
  base="$(env_value MCP_BASE_URL)"
  port="${base##*:}"
  port="${port%%/*}"
  case "$port" in
    '' | *[!0-9]*) echo 3013 ;;
    *) echo "$port" ;;
  esac
}

wait_for_health() {
  local url="$1/health" deadline
  say "Waiting for ${url} (up to ${HEALTH_TIMEOUT_SECONDS}s)"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ curl -fsS --max-time 3 %s  # retried until it answers\n' "$url"
    return 0
  fi
  deadline=$(($(date +%s) + HEALTH_TIMEOUT_SECONDS))
  until curl -fsS --max-time 3 -o /dev/null "$url" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      die "API did not become healthy at ${url}. Check: cd ${INSTALL_DIR} && docker compose logs swarm-api"
    fi
    sleep 2
  done
  say "API is healthy"
}

urlencode() {
  local s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

lt_command() {
  if have lt && lt --help 2>/dev/null | grep -q "lt.desplega.ai"; then
    echo "lt"
  else
    echo "bunx --package @desplega.ai/localtunnel@${LT_VERSION} lt"
  fi
}

# Stop a tunnel from a previous run. The pid may be a `bunx` wrapper whose
# `lt` child survives a plain kill, so stop the children first and wait.
stop_tunnel() {
  local pid i
  [ -f .agent-swarm/tunnel.pid ] || return 0
  pid="$(cat .agent-swarm/tunnel.pid)"
  case "$pid" in '' | *[!0-9]*) return 0 ;; esac
  kill -0 "$pid" 2>/dev/null || return 0
  say "Stopping the previous tunnel (pid ${pid})"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ kill %s and its children, wait up to 10s\n' "$pid"
    return 0
  fi
  local pids p alive
  pids="$pid $(pgrep -P "$pid" 2>/dev/null | tr '\n' ' ' || true)"
  for p in $pids; do kill "$p" 2>/dev/null || true; done
  for ((i = 0; i < 10; i++)); do
    alive=0
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ "$alive" -eq 0 ] && break
    sleep 1
  done
}

# Point the stack at its public URL: PUBLIC_MCP_BASE_URL in .env, an override
# that passes it to the API (the generated compose does not), then recreate the
# API and agent-fs. Compose only recreates a service whose config changed.
apply_public_url() {
  local url="$1" port="$2"
  set_env_value PUBLIC_MCP_BASE_URL "$url"
  # An override without services: holds only install.sh's --bind network.
  local file="${INSTALL_DIR}/${OVERRIDE_FILE}"
  if [ ! -f "$file" ] || ! grep -qE '^services:' "$file"; then
    say "Writing docker-compose.override.yml to pass PUBLIC_MCP_BASE_URL to the API"
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '+ write docker-compose.override.yml (swarm-api.environment += PUBLIC_MCP_BASE_URL)\n'
    else
      start_override
      cat >>"$file" <<'YAML'
services:
  swarm-api:
    environment:
      - PUBLIC_MCP_BASE_URL=${PUBLIC_MCP_BASE_URL:-}
YAML
    fi
  fi

  # agent-fs reads PUBLIC_MCP_BASE_URL from .env for AGENT_FS_PUBLIC_URL, so
  # recreate it too.
  if has_agent_fs_service; then
    say "Restarting the API and agent-fs with PUBLIC_MCP_BASE_URL=${url}"
    compose_up swarm-api agent-fs
  else
    say "Restarting the API with PUBLIC_MCP_BASE_URL=${url}"
    compose_up swarm-api
  fi
  wait_for_health "http://localhost:${port}"
}

start_tunnel() {
  local port="$1" lt_cmd url="" i code
  lt_cmd="$(lt_command)"
  run mkdir -p .agent-swarm

  stop_tunnel

  say "Starting tunnel: ${lt_cmd} --port ${port}"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ nohup %s --port %s >.agent-swarm/tunnel.log 2>&1 &  # pid -> .agent-swarm/tunnel.pid\n' "$lt_cmd" "$port"
    url="https://<random>.lt.desplega.ai"
  else
    # A fresh file: a straggler still holding the old log open cannot write
    # into the new one.
    rm -f .agent-swarm/tunnel.log
    # shellcheck disable=SC2086 # lt_cmd is a trusted multi-word command
    nohup $lt_cmd --port "$port" >.agent-swarm/tunnel.log 2>&1 </dev/null &
    echo $! >.agent-swarm/tunnel.pid
    disown 2>/dev/null || true
    for ((i = 0; i < 60; i++)); do
      url="$(grep -aoE 'https://[^ ]+' .agent-swarm/tunnel.log 2>/dev/null | head -n 1 || true)"
      [ -n "$url" ] && break
      kill -0 "$(cat .agent-swarm/tunnel.pid)" 2>/dev/null || break
      sleep 1
    done
    [ -n "$url" ] || die "tunnel did not report a URL. See ${INSTALL_DIR}/.agent-swarm/tunnel.log"
  fi
  say "Tunnel URL: ${url}"

  apply_public_url "$url" "$port"

  # A fresh tunnel name has no TLS certificate yet. The tunnel server gets one
  # on the first request, which usually takes 30s but can take minutes. Wait
  # here, so the user's first click works.
  say "Warming up the tunnel (a new tunnel needs a TLS certificate; up to ${TUNNEL_WARMUP_SECONDS}s)"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ curl -s --max-time 20 %s/health  # retried until 200, up to %ss\n' "$url" "$TUNNEL_WARMUP_SECONDS"
  else
    local start next_note now
    code=000
    start=$(date +%s)
    next_note=$((start + 30))
    while :; do
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${url}/health" || true)"
      [ "$code" = "200" ] && break
      now=$(date +%s)
      [ "$now" -ge $((start + TUNNEL_WARMUP_SECONDS)) ] && break
      if [ "$now" -ge "$next_note" ]; then
        say "Still waiting for the tunnel ($((now - start))s)"
        next_note=$((now + 30))
      fi
      sleep 2
    done
    if [ "$code" = "200" ]; then
      say "Tunnel is serving ${url}/health"
    else
      warn "the tunnel did not answer in ${TUNNEL_WARMUP_SECONDS}s (last HTTP status: ${code}). Its TLS certificate is probably not ready yet."
      warn "Wait a few minutes, then open the dashboard link below. If it still fails, run the installer again with --tunnel to get a new tunnel. Log: ${INSTALL_DIR}/.agent-swarm/tunnel.log"
    fi
  fi
  TUNNEL_URL="$url"
}

main() {
  parse_args "$@"
  [ "$DRY_RUN" -eq 1 ] && say "Dry run: printing commands, changing nothing"
  have curl || die "curl is required"

  check_docker
  ensure_bun

  run mkdir -p "$INSTALL_DIR"
  if [ -d "$INSTALL_DIR" ]; then cd "$INSTALL_DIR"; fi
  say "Install directory: ${INSTALL_DIR}"

  # The network default and the exported address make the first `docker
  # compose up` (inside onboard) bind there, whatever the CLI release. A compose
  # file without the bind prefix gets it and the stack is recreated; then the
  # running ports are checked. Until that check passes, on_exit stops the stack
  # on any exit.
  if [ -n "$BIND_ADDRESS" ]; then
    export AGENT_SWARM_BIND_ADDRESS="$BIND_ADDRESS"
    if [ "$DRY_RUN" -eq 0 ]; then
      PORTS_UNCHECKED=1
      trap on_exit EXIT
    fi
    [ -f "${INSTALL_DIR}/docker-compose.yml" ] || check_project_network
    bind_network_default
  fi
  onboard
  if [ -n "$BIND_ADDRESS" ]; then
    set_env_value AGENT_SWARM_BIND_ADDRESS "$BIND_ADDRESS"
    if bind_compose_ports; then compose_up; fi
    assert_ports_bound
    PORTS_UNCHECKED=0
  fi

  local port api_key local_url dash_url
  port="$(api_port)"
  local_url="http://localhost:${port}"
  wait_for_health "$local_url"

  TUNNEL_URL=""
  resolve_tunnel
  if [ "$TUNNEL" -eq 1 ]; then
    start_tunnel "$port"
    PUBLIC_URL="$TUNNEL_URL"
  else
    # Without --public-url, keep an own-domain PUBLIC_MCP_BASE_URL from .env. A
    # stale tunnel URL is dead once the tunnel is off, so it does not count.
    if [ -z "$PUBLIC_URL" ]; then
      PUBLIC_URL="$(env_value PUBLIC_MCP_BASE_URL)"
      case "$PUBLIC_URL" in https://*.lt.desplega.ai | https://*.lt.desplega.ai/*) PUBLIC_URL="" ;; esac
    fi
    [ -z "$PUBLIC_URL" ] || apply_public_url "$PUBLIC_URL" "$port"
  fi

  api_key="$(env_value API_KEY)"
  [ -n "$api_key" ] || api_key="<API_KEY from ${INSTALL_DIR}/.env>"
  dash_url="${DASHBOARD_BASE}/setup?apiUrl=$(urlencode "${PUBLIC_URL:-$local_url}")&apiKey=$(urlencode "$api_key")"

  printf '\n'
  say "Agent Swarm is running"
  printf '  API:        %s\n' "$local_url"
  [ -n "$PUBLIC_URL" ] && printf '  Public API: %s\n' "$PUBLIC_URL"
  printf '  Files:      %s\n' "$INSTALL_DIR"
  printf '\n  Finish setup (harness credentials, integrations) in the dashboard:\n'
  printf '  %s\n\n' "$dash_url"
  printf '  Logs: cd %s && docker compose logs -f\n' "$INSTALL_DIR"
  printf '  Stop: cd %s && docker compose down\n' "$INSTALL_DIR"
}

main "$@"
