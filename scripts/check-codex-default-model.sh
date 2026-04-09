#!/usr/bin/env bash
# Verify the baseline Codex model in Dockerfile.worker matches
# CODEX_DEFAULT_MODEL exported by src/providers/codex-models.ts.
# Run from the repo root (or any subdirectory).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="$ROOT/Dockerfile.worker"
MODELS_TS="$ROOT/src/providers/codex-models.ts"

if [ ! -f "$DOCKERFILE" ] || [ ! -f "$MODELS_TS" ]; then
  echo "check-codex-default-model: missing Dockerfile.worker or src/providers/codex-models.ts" >&2
  exit 1
fi

dockerfile_model=$(grep -oE "'model = \"[^\"]+\"'" "$DOCKERFILE" | head -1 | sed -E "s/.*\"([^\"]+)\".*/\1/")
ts_default=$(grep -oE 'CODEX_DEFAULT_MODEL: CodexModel = "[^"]+"' "$MODELS_TS" | sed -E 's/.*"([^"]+)"$/\1/')

if [ -z "$dockerfile_model" ] || [ -z "$ts_default" ]; then
  echo "check-codex-default-model: failed to extract model from one or both files" >&2
  exit 1
fi

if [ "$dockerfile_model" != "$ts_default" ]; then
  echo "check-codex-default-model: MISMATCH" >&2
  echo "  Dockerfile.worker baseline: $dockerfile_model" >&2
  echo "  src/providers/codex-models.ts CODEX_DEFAULT_MODEL: $ts_default" >&2
  exit 1
fi

echo "Codex default model check passed ($dockerfile_model)"
