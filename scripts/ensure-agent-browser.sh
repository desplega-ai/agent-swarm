#!/usr/bin/env bash
set -euo pipefail

# Standalone pin: bump and validate agent-browser independently from the
# coupled weekly harness-upgrade bundle.
AGENT_BROWSER_VERSION="0.33.1"
BOOTSTRAP_ROOT="${AGENT_BROWSER_BOOTSTRAP_ROOT:-/workspace/personal/.agent-browser-bootstrap}"
LINK_DIR="${AGENT_BROWSER_LINK_DIR:-${HOME}/.local/bin}"
VERSIONS_DIR="${BOOTSTRAP_ROOT}/versions"
INSTALL_DIR="${VERSIONS_DIR}/${AGENT_BROWSER_VERSION}"
INSTALL_BIN="${INSTALL_DIR}/bin/agent-browser"
BROWSER_HOME="${BOOTSTRAP_ROOT}/browser-home"
LOCK_FILE="${BOOTSTRAP_ROOT}/install.lock"
CLI_PATH_FILE="${BOOTSTRAP_ROOT}/cli-path"
BROWSER_PATH_FILE="${BOOTSTRAP_ROOT}/browser-path"
WRAPPER_PATH="${LINK_DIR}/agent-browser"
PLAYWRIGHT_FALLBACK_ROOT="${AGENT_BROWSER_PLAYWRIGHT_ROOT-/opt/playwright}"
read -r -a SYSTEM_BROWSER_COMMANDS <<< \
  "${AGENT_BROWSER_SYSTEM_BROWSER_COMMANDS:-google-chrome-stable google-chrome chromium chromium-browser}"

case "$BOOTSTRAP_ROOT" in
  "" | "/")
    echo "ensure-agent-browser: unsafe bootstrap root: ${BOOTSTRAP_ROOT:-<empty>}" >&2
    exit 1
    ;;
esac

mkdir -p "$BOOTSTRAP_ROOT" "$VERSIONS_DIR" "$BROWSER_HOME" "$LINK_DIR"

exec 9>"$LOCK_FILE"
flock 9

agent_browser_version() {
  "$1" --version 2>/dev/null | awk 'NR == 1 { print $NF }'
}

atomic_write() {
  local destination="$1"
  local value="$2"
  local temporary="${destination}.tmp.$$"
  printf '%s\n' "$value" > "$temporary"
  mv -f "$temporary" "$destination"
}

find_playwright_browser() {
  local root="$1"
  local candidate=""

  [ -d "$root" ] || return 1

  candidate="$(
    find "$root" -type f -path "*/chrome-linux*/chrome" -perm -111 -print 2>/dev/null \
      | sort -V \
      | tail -1
  )"
  if [ -n "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  candidate="$(
    find "$root" -type f -path "*/chrome-headless-shell-linux*/chrome-headless-shell" \
      -perm -111 -print 2>/dev/null \
      | sort -V \
      | tail -1
  )"
  [ -n "$candidate" ] || return 1
  printf '%s\n' "$candidate"
}

find_downloaded_browser() {
  local candidate=""
  candidate="$(
    find "${BROWSER_HOME}/.agent-browser/browsers" -type f -name chrome -perm -111 -print \
      2>/dev/null \
      | sort -V \
      | tail -1
  )"
  [ -n "$candidate" ] || return 1
  printf '%s\n' "$candidate"
}

resolve_existing_browser() {
  local candidate=""
  local browser_command=""

  if [ -n "${AGENT_BROWSER_EXECUTABLE_PATH:-}" ] \
    && [ -x "$AGENT_BROWSER_EXECUTABLE_PATH" ]; then
    printf '%s\n' "$AGENT_BROWSER_EXECUTABLE_PATH"
    return 0
  fi

  if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
    candidate="$(find_playwright_browser "$PLAYWRIGHT_BROWSERS_PATH" || true)"
    if [ -n "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  if [ -n "$PLAYWRIGHT_FALLBACK_ROOT" ]; then
    candidate="$(find_playwright_browser "$PLAYWRIGHT_FALLBACK_ROOT" || true)"
    if [ -n "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  for browser_command in "${SYSTEM_BROWSER_COMMANDS[@]}"; do
    candidate="$(command -v "$browser_command" 2>/dev/null || true)"
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  find_downloaded_browser
}

cli_path=""
if [ -x "$INSTALL_BIN" ] \
  && [ "$(agent_browser_version "$INSTALL_BIN" || true)" = "$AGENT_BROWSER_VERSION" ]; then
  cli_path="$INSTALL_BIN"
else
  existing_cli="$(command -v agent-browser 2>/dev/null || true)"
  if [ -n "$existing_cli" ] \
    && [ "$existing_cli" != "$WRAPPER_PATH" ] \
    && [ "$(agent_browser_version "$existing_cli" || true)" = "$AGENT_BROWSER_VERSION" ]; then
    cli_path="$existing_cli"
  fi
fi

if [ -z "$cli_path" ]; then
  rm -rf "$INSTALL_DIR"
  HOME="$BROWSER_HOME" NPM_CONFIG_CACHE="${BOOTSTRAP_ROOT}/npm-cache" \
    npm install --global --prefix "$INSTALL_DIR" --no-audit --no-fund --ignore-scripts \
    "agent-browser@${AGENT_BROWSER_VERSION}"

  if [ ! -x "$INSTALL_BIN" ] \
    || [ "$(agent_browser_version "$INSTALL_BIN" || true)" != "$AGENT_BROWSER_VERSION" ]; then
    echo "ensure-agent-browser: npm install did not produce agent-browser ${AGENT_BROWSER_VERSION}" >&2
    exit 1
  fi

  cli_path="$INSTALL_BIN"
fi

browser_path="$(resolve_existing_browser || true)"
if [ -z "$browser_path" ]; then
  HOME="$BROWSER_HOME" "$cli_path" install
  browser_path="$(find_downloaded_browser || true)"
fi

if [ -z "$browser_path" ] || [ ! -x "$browser_path" ]; then
  echo "ensure-agent-browser: no executable Chrome/Chromium found after installation" >&2
  exit 1
fi

atomic_write "$CLI_PATH_FILE" "$cli_path"
atomic_write "$BROWSER_PATH_FILE" "$browser_path"

wrapper_tmp="${WRAPPER_PATH}.tmp.$$"
cat > "$wrapper_tmp" <<EOF
#!/bin/sh
set -eu
cli_path=\$(cat "${CLI_PATH_FILE}")
if [ -z "\${AGENT_BROWSER_EXECUTABLE_PATH:-}" ]; then
  AGENT_BROWSER_EXECUTABLE_PATH=\$(cat "${BROWSER_PATH_FILE}")
  export AGENT_BROWSER_EXECUTABLE_PATH
fi
exec "\$cli_path" "\$@"
EOF
chmod 755 "$wrapper_tmp"
mv -f "$wrapper_tmp" "$WRAPPER_PATH"

printf 'agent-browser ready: cli %s, browser %s\n' "$AGENT_BROWSER_VERSION" "$browser_path"
