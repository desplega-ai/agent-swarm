#!/usr/bin/env bash
# Agent Swarm one-shot self-host installer.
#
#   curl -fsSL https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/install.sh | bash -s -- --tunnel
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
TUNNEL=0
INSTALL_DIR="${AGENT_SWARM_DIR:-$DEFAULT_DIR}"
PRESET="${AGENT_SWARM_PRESET:-$DEFAULT_PRESET}"
CLI_VERSION="${AGENT_SWARM_CLI_VERSION:-$DEFAULT_CLI_VERSION}"
LT_VERSION="${AGENT_SWARM_LT_VERSION:-$DEFAULT_LT_VERSION}"
CLI_PACKAGE="${AGENT_SWARM_CLI_PACKAGE:-}"

usage() {
  cat <<EOF
Agent Swarm installer: one command from zero to a running self-hosted swarm.

Usage:
  curl -fsSL https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/install.sh | bash
  curl -fsSL .../install.sh | bash -s -- [options]
  bash install.sh [options]

Options:
  --dir <path>       Install directory (default: \$AGENT_SWARM_DIR, else ~/agent-swarm)
  --version <ver>    @desplega.ai/agent-swarm npm version to run (default: latest)
  --tunnel           Expose the API publicly with localtunnel (lt.desplega.ai) and
                     set PUBLIC_MCP_BASE_URL. Off by default. See "Tunnel" below.
  --dry-run          Print every command instead of running it
  -h, --help         Show this help

Environment:
  AGENT_SWARM_DIR          Same as --dir
  AGENT_SWARM_CLI_VERSION  Same as --version
  AGENT_SWARM_CLI_PACKAGE  Full package spec for the CLI instead of the npm release:
                           a tarball path or URL from \`bun pm pack\` (testing unreleased builds)
  AGENT_SWARM_LT_VERSION   @desplega.ai/localtunnel version for --tunnel (default: ${DEFAULT_LT_VERSION})
  CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY,
  HARNESS_PROVIDER, GITHUB_TOKEN, SLACK_BOT_TOKEN, ...
                           Passed through to \`agent-swarm onboard --yes\`. All optional:
                           without a harness credential the workers start and wait
                           until you add one on the dashboard /setup page.

What it does:
  1. Checks for Docker and Docker Compose v2 (exits with an install link if missing).
  2. Installs Bun from ${BUN_INSTALL_URL} if bun is not on PATH.
  3. Runs \`bunx @desplega.ai/agent-swarm@<version> onboard --yes --preset full\`
     in the install directory: a lead and 10 workers. That writes docker-compose.yml and .env and runs
     \`docker compose up -d\`. If docker-compose.yml already exists, it skips
     onboarding and only runs \`docker compose up -d\`.
  4. Waits for http://localhost:<port>/health.
  5. Prints the dashboard link to /setup with the API URL and key filled in.

Tunnel (--tunnel):
  Runs \`lt --port <port>\` in the background (pid in .agent-swarm/tunnel.pid, log in
  .agent-swarm/tunnel.log), writes the public URL to PUBLIC_MCP_BASE_URL in .env,
  adds docker-compose.override.yml to pass it to the API, restarts the API and
  sends warm-up requests (the first request through a fresh tunnel can hang).
  The URL is random and changes whenever the tunnel restarts, including after a
  reboot. Anyone with the URL can reach your API; every route except /health
  still needs the API key. Re-running with --tunnel replaces the tunnel. Stop it:
    pkill -P "\$(cat .agent-swarm/tunnel.pid)"; kill "\$(cat .agent-swarm/tunnel.pid)"

Examples:
  curl -fsSL .../install.sh | bash
  curl -fsSL .../install.sh | ANTHROPIC_API_KEY=sk-ant-... bash
  bash install.sh --dry-run --tunnel
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
      --tunnel) TUNNEL=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
  done
  case "$PRESET" in
    solo | dev | content | research | full) ;;
    *) die "invalid preset '$PRESET'. Options: solo, dev, content, research, full" ;;
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
    compose_up
    return 0
  fi
  local spec="${CLI_PACKAGE:-@desplega.ai/agent-swarm@${CLI_VERSION}}"
  say "Running agent-swarm onboard (preset: ${PRESET}, cli: ${spec})"
  run bunx --package "$spec" agent-swarm onboard --yes --preset "$PRESET" \
    --container-engine docker </dev/null
}

# Read KEY=value from .env (last match wins, like Compose).
env_value() {
  local file="${INSTALL_DIR}/.env"
  [ -f "$file" ] || return 0
  grep -E "^$1=" "$file" | tail -n 1 | cut -d= -f2- || true
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

  set_env_value PUBLIC_MCP_BASE_URL "$url"
  if [ ! -f "${INSTALL_DIR}/docker-compose.override.yml" ]; then
    say "Writing docker-compose.override.yml to pass PUBLIC_MCP_BASE_URL to the API"
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '+ write docker-compose.override.yml (swarm-api.environment += PUBLIC_MCP_BASE_URL)\n'
    else
      cat >"${INSTALL_DIR}/docker-compose.override.yml" <<'YAML'
# Written by install.sh --tunnel. Compose merges this file into
# docker-compose.yml automatically.
services:
  swarm-api:
    environment:
      - PUBLIC_MCP_BASE_URL=${PUBLIC_MCP_BASE_URL:-}
YAML
    fi
  fi

  say "Restarting the API with PUBLIC_MCP_BASE_URL=${url}"
  compose_up swarm-api
  wait_for_health "http://localhost:${port}"

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

  onboard

  local port api_key local_url dash_url
  port="$(api_port)"
  local_url="http://localhost:${port}"
  wait_for_health "$local_url"

  TUNNEL_URL=""
  if [ "$TUNNEL" -eq 1 ]; then start_tunnel "$port"; fi

  api_key="$(env_value API_KEY)"
  [ -n "$api_key" ] || api_key="<API_KEY from ${INSTALL_DIR}/.env>"
  dash_url="${DASHBOARD_BASE}/setup?apiUrl=$(urlencode "${TUNNEL_URL:-$local_url}")&apiKey=$(urlencode "$api_key")"

  printf '\n'
  say "Agent Swarm is running"
  printf '  API:        %s\n' "$local_url"
  [ -n "$TUNNEL_URL" ] && printf '  Public API: %s\n' "$TUNNEL_URL"
  printf '  Files:      %s\n' "$INSTALL_DIR"
  printf '\n  Finish setup (harness credentials, integrations) in the dashboard:\n'
  printf '  %s\n\n' "$dash_url"
  printf '  Logs: cd %s && docker compose logs -f\n' "$INSTALL_DIR"
  printf '  Stop: cd %s && docker compose down\n' "$INSTALL_DIR"
}

main "$@"
