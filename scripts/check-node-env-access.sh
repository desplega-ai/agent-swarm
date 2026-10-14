#!/bin/bash
# Enforce that src/ reads NODE_ENV through getNodeEnv() (src/utils/node-env.ts).
#
# `bun build --compile` replaces every dot read of NODE_ENV on process.env
# with the build-time constant "development". The compiled API image then ran
# as development: the SSRF guard let MCP and script-connection endpoints reach
# private and plain-http hosts. getNodeEnv() uses a computed key, which Bun
# reads at runtime. src/tests/node-env-runtime.test.ts compiles a binary to
# prove it; this check keeps new dot reads out of src/.
#
# Test files are exempt: they run uncompiled under `bun test`.

set -euo pipefail

PATTERN='process\.env\??\.NODE_ENV\b'

VIOLATIONS=$(
  grep -rnE "$PATTERN" --include='*.ts' --include='*.tsx' src/ \
    | grep -vE '^src/tests/|\.test\.tsx?:' || true
)

if [ -n "$VIOLATIONS" ]; then
  echo "ERROR: direct process.env.NODE_ENV read in src/!"
  echo ""
  echo "bun build --compile inlines it as \"development\", so the compiled"
  echo "binaries never see the deployment's NODE_ENV."
  echo ""
  echo "Violations:"
  echo "$VIOLATIONS"
  echo ""
  echo "Fix: import { getNodeEnv } from src/utils/node-env.ts and call it instead."
  exit 1
fi

echo "NODE_ENV runtime-read check passed."
