#!/usr/bin/env bash
set -euo pipefail

# Toolchain setup for open-prompt motion-graphics videos on an Agent Swarm worker container.
#
# Idempotent: every step checks first, so it is cheap to run at every container start from the
# worker setupScript. Needs no root. Everything it installs lives under BASE_DIR, which should be on
# a path that survives a container restart (/workspace/personal does; $HOME does not).
#
# What the stock worker image already ships (checked, not reinstalled):
#   node, bun, python3 + venv, ffmpeg 7.0.2 static (libx264, aac, no ffprobe, no drawtext),
#   playwright 1.58.0 under /opt/global-deps-full, Chromium under /opt/playwright, agent-fs CLI.
# What this script adds:
#   ffprobe (optional), numpy in a venv (music beat analysis), the three fonts (sha256-pinned),
#   the real Agent Swarm logo, the render/sheet/music/encode tools, and the TLA+ example reel.
# If the image lacks ffmpeg or playwright, it falls back to a pinned static ffmpeg and a local
# playwright install (force either with FORCE_LOCAL_FFMPEG=1 / FORCE_LOCAL_PLAYWRIGHT=1). Chromium's
# system libraries need root to install (`npx playwright install-deps chromium`); this script cannot.
#
# Usage: bash setup.sh            (BASE_DIR=/workspace/personal/showreel-toolkit by default)
#        INSTALL_FFPROBE=0 bash setup.sh

BASE_DIR="${BASE_DIR:-/workspace/personal/showreel-toolkit}"
INSTALL_FFPROBE="${INSTALL_FFPROBE:-1}"
FORCE_LOCAL_FFMPEG="${FORCE_LOCAL_FFMPEG:-0}"           # 1 = ignore the system ffmpeg, install the pinned build
FORCE_LOCAL_PLAYWRIGHT="${FORCE_LOCAL_PLAYWRIGHT:-0}"   # 1 = ignore /opt/global-deps-full, install playwright locally
FFMPEG_VERSION="${FFMPEG_VERSION:-7.0.2}"
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.58.0}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Same pins as the worker image (Dockerfile.worker). Bump the version and both hashes together.
FFMPEG_SHA256_AMD64="abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67"
FFMPEG_SHA256_ARM64="f4149bb2b0784e30e99bdda85471c9b5930d3402014e934a5098b41d0f7201b1"

# Fonts come from github.com/google/fonts (SIL Open Font License 1.1). The hashes are the exact files the reels used.
FONT_BASE="https://raw.githubusercontent.com/google/fonts/main/ofl"
FONTS=(
  "SpaceGrotesk.ttf|$FONT_BASE/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf|acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72"
  "JetBrainsMono.ttf|$FONT_BASE/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf|48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda"
  "InstrumentSerif-Italic.ttf|$FONT_BASE/instrumentserif/InstrumentSerif-Italic.ttf|08939b8bdf534afec24ae0ef5e03f948940cd9a8fe08e7fecbad040e62327385"
)

log() { printf '[showreel-setup] %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
die() { log "ERROR: $*"; exit 1; }

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 FFMPEG_SHA256="$FFMPEG_SHA256_AMD64" ;;
  aarch64 | arm64) ARCH=arm64 FFMPEG_SHA256="$FFMPEG_SHA256_ARM64" ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

mkdir -p "$BASE_DIR"/{bin,assets/fonts,assets/music,work}
export PATH="$BASE_DIR/bin:$BASE_DIR/.venv/bin:$PATH"

# 1. Base runtimes. Nothing here is installed; a worker without them is not a worker image.
for t in node npm bun python3 curl tar; do have "$t" || die "$t is missing"; done
log "node $(node --version), bun $(bun --version), $(python3 --version)"

# 2. ffmpeg (+ optional ffprobe) from the pinned static build.
fetch_ffmpeg_tarball() {
  local tar="$BASE_DIR/work/ffmpeg-$FFMPEG_VERSION-$ARCH.tar.xz"
  if [ ! -s "$tar" ]; then
    local base="ffmpeg-$FFMPEG_VERSION-$ARCH-static.tar.xz"
    curl -fsSL "https://johnvansickle.com/ffmpeg/releases/$base" -o "$tar" ||
      curl -fsSL "https://johnvansickle.com/ffmpeg/old-releases/$base" -o "$tar"
  fi
  echo "$FFMPEG_SHA256  $tar" | sha256sum -c - >/dev/null || { rm -f "$tar"; die "ffmpeg tarball sha256 mismatch"; }
  echo "$tar"
}
# Capture first: `ffmpeg ... | grep -q` dies of SIGPIPE under pipefail and reads as "no libx264".
has_x264() { have ffmpeg && grep -q libx264 <<<"$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"; }
if [ "$FORCE_LOCAL_FFMPEG" != 1 ] && has_x264; then
  log "ffmpeg ok: $(ffmpeg -version | head -1 | cut -c1-40)"
else
  log "ffmpeg with libx264 not found, installing pinned $FFMPEG_VERSION static build"
  tar -xJf "$(fetch_ffmpeg_tarball)" -C "$BASE_DIR/bin" --strip-components=1 "ffmpeg-$FFMPEG_VERSION-$ARCH-static/ffmpeg"
fi
if [ "$INSTALL_FFPROBE" = 1 ] && ! have ffprobe; then
  log "installing ffprobe $FFMPEG_VERSION (the worker image ships ffmpeg only)"
  tar -xJf "$(fetch_ffmpeg_tarball)" -C "$BASE_DIR/bin" --strip-components=1 "ffmpeg-$FFMPEG_VERSION-$ARCH-static/ffprobe"
fi

# 3. Playwright + Chromium. The worker image has them under /opt; otherwise install locally.
PLAYWRIGHT_ROOT=""
for root in /opt/global-deps-full/node_modules "$BASE_DIR/node_modules"; do
  if [ "$FORCE_LOCAL_PLAYWRIGHT" = 1 ] && [ "$root" != "$BASE_DIR/node_modules" ]; then continue; fi
  if [ -d "$root/playwright" ]; then PLAYWRIGHT_ROOT="$root"; break; fi
done
if [ -z "$PLAYWRIGHT_ROOT" ]; then
  log "playwright not found, installing playwright@$PLAYWRIGHT_VERSION into $BASE_DIR"
  npm install --prefix "$BASE_DIR" --no-audit --no-fund "playwright@$PLAYWRIGHT_VERSION" >/dev/null
  PLAYWRIGHT_ROOT="$BASE_DIR/node_modules"
fi
if [ "$FORCE_LOCAL_PLAYWRIGHT" = 1 ]; then
  export PLAYWRIGHT_BROWSERS_PATH="$BASE_DIR/browsers"
elif [ -d /opt/playwright ]; then
  export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
else
  export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$BASE_DIR/browsers}"
fi
smoke() {
  PLAYWRIGHT_ROOT="$PLAYWRIGHT_ROOT" node -e '
    const { createRequire } = require("node:module");
    const { chromium } = createRequire(process.env.PLAYWRIGHT_ROOT + "/")("playwright");
    (async () => {
      const b = await chromium.launch();
      const p = await b.newPage({ viewport: { width: 64, height: 64 } });
      await p.setContent("<canvas id=c></canvas>");
      console.log("chromium", b.version());
      await b.close();
    })().catch((e) => { console.error(String(e.message).split("\n")[0]); process.exit(1); });
  ' 2>&1
}
if ! chromium_out=$(smoke); then
  log "no working Chromium, running playwright install chromium into $PLAYWRIGHT_BROWSERS_PATH"
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" "$PLAYWRIGHT_ROOT/.bin/playwright" install chromium >/dev/null
  chromium_out=$(smoke) || die "Chromium still does not launch: $chromium_out (missing system libraries need root: npx playwright install-deps chromium)"
fi
log "playwright $(PLAYWRIGHT_ROOT="$PLAYWRIGHT_ROOT" node -e 'console.log(require("node:module").createRequire(process.env.PLAYWRIGHT_ROOT + "/")("playwright/package.json").version)'), $chromium_out"

# 4. numpy in a venv, for the music beat/drop analysis. A venv survives restarts, ~/.local does not.
if ! "$BASE_DIR/.venv/bin/python" -c 'import numpy' 2>/dev/null; then
  log "creating venv and installing numpy"
  python3 -m venv "$BASE_DIR/.venv"
  "$BASE_DIR/.venv/bin/pip" install --quiet --disable-pip-version-check numpy
fi
log "numpy $("$BASE_DIR/.venv/bin/python" -c 'import numpy; print(numpy.__version__)')"

# 5. Fonts, sha256-pinned.
for spec in "${FONTS[@]}"; do
  IFS='|' read -r name url sha <<<"$spec"
  dest="$BASE_DIR/assets/fonts/$name"
  if [ -s "$dest" ] && echo "$sha  $dest" | sha256sum -c - >/dev/null 2>&1; then continue; fi
  log "downloading $name"
  curl -fsSL "$url" -o "$dest"
  echo "$sha  $dest" | sha256sum -c - >/dev/null || { rm -f "$dest"; die "$name sha256 mismatch (google/fonts changed it: re-pin the hash after looking at the new file)"; }
done
log "fonts ok: $(ls "$BASE_DIR/assets/fonts" | tr '\n' ' ')"

# 6. The real Agent Swarm logo. Never draw your own. Repo copy and live site must match; the live site wins.
if [ ! -s "$BASE_DIR/assets/logo.png" ]; then
  curl -fsSL "https://agent-swarm.dev/logo.png" -o "$BASE_DIR/assets/logo.png"
  curl -fsSL "https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/apps/ui/public/logo.png" -o "$BASE_DIR/work/logo.repo.png"
  if ! cmp -s "$BASE_DIR/assets/logo.png" "$BASE_DIR/work/logo.repo.png"; then
    log "WARNING: agent-swarm.dev/logo.png differs from apps/ui/public/logo.png on main. Using the live site copy; say so in the output."
  fi
fi
log "logo sha256 $(sha256sum "$BASE_DIR/assets/logo.png" | cut -c1-16)"

# 7. Tools, example reel and the environment file.
mkdir -p "$BASE_DIR/tools" "$BASE_DIR/example"
if [ "$SELF_DIR" != "$BASE_DIR" ]; then
  cp -r "$SELF_DIR/tools/." "$BASE_DIR/tools/"
  cp -r "$SELF_DIR/example/." "$BASE_DIR/example/"
  cp "$SELF_DIR/setup.sh" "$BASE_DIR/setup.sh"
fi
chmod +x "$BASE_DIR"/tools/*.sh
cat >"$BASE_DIR/env.sh" <<EOF
# source this before working: . $BASE_DIR/env.sh
export PATH="$BASE_DIR/bin:$BASE_DIR/.venv/bin:\$PATH"
export PLAYWRIGHT_ROOT="$PLAYWRIGHT_ROOT"
export PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH"
export FONTS="SG=$BASE_DIR/assets/fonts/SpaceGrotesk.ttf,JB=$BASE_DIR/assets/fonts/JetBrainsMono.ttf,IS=$BASE_DIR/assets/fonts/InstrumentSerif-Italic.ttf"
export LOGO="$BASE_DIR/assets/logo.png"
EOF
log "done. Next: . $BASE_DIR/env.sh && cd $BASE_DIR/example/tla-races && bash smoke.sh"
