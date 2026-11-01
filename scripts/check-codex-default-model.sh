#!/usr/bin/env bash
# Verify the Codex pins in Dockerfile.worker match the source of truth:
#   1. The baseline `model = "..."` in ~/.codex/config.toml equals the live
#      CODEX_DEFAULT_MODEL exported by src/providers/codex-models.ts.
#   2. `ARG CODEX_VERSION=` equals the direct `@openai/codex` pin in
#      package.json.
# Run from anywhere inside the repo; needs bun and installed deps.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="$ROOT/Dockerfile.worker"
MODELS_TS="$ROOT/src/providers/codex-models.ts"
PACKAGE_JSON="$ROOT/package.json"
DOC_FILE="$ROOT/docs-site/content/docs/(documentation)/guides/harness-configuration.mdx"

for f in "$DOCKERFILE" "$MODELS_TS" "$PACKAGE_JSON" "$DOC_FILE"; do
  if [ ! -f "$f" ]; then
    echo "check-codex-default-model: missing ${f#"$ROOT"/}" >&2
    exit 1
  fi
done

dockerfile_model=$(grep -oE "'model = \"[^\"]+\"'" "$DOCKERFILE" | head -1 | sed -E "s/.*\"([^\"]+)\".*/\1/" || true)
# Import the constant instead of grepping its declaration: the value is
# derived (DEFAULT_MODEL_TIER_MAP.codex.regular), so no source regex can see it.
ts_default=$(cd "$ROOT" && bun -e 'import { CODEX_DEFAULT_MODEL } from "./src/providers/codex-models.ts"; console.log(CODEX_DEFAULT_MODEL);')

if [ -z "$dockerfile_model" ]; then
  echo "check-codex-default-model: no 'model = \"...\"' line in Dockerfile.worker" >&2
  exit 1
fi
if [ -z "$ts_default" ]; then
  echo "check-codex-default-model: CODEX_DEFAULT_MODEL resolved to an empty value" >&2
  exit 1
fi

# Keep the operator-facing guide aligned with the runtime default and document both override paths.
documented_default=$(sed -n 's/.*Codex uses `\([^`]*\)`.*/\1/p' "$DOC_FILE" | head -1 || true)
if [ -z "$documented_default" ] || [ "$documented_default" != "$ts_default" ]; then
  echo "check-codex-default-model: documentation default MISMATCH" >&2
  echo "  docs-site Codex default: ${documented_default:-<missing>}" >&2
  echo "  CODEX_DEFAULT_MODEL: $ts_default" >&2
  exit 1
fi
if ! grep -Fq '`MODEL_OVERRIDE`' "$DOC_FILE" || ! grep -Fq 'task-level `model`' "$DOC_FILE"; then
  echo "check-codex-default-model: Codex docs must describe MODEL_OVERRIDE and task-level model overrides" >&2
  exit 1
fi

if [ "$dockerfile_model" != "$ts_default" ]; then
  echo "check-codex-default-model: MISMATCH" >&2
  echo "  Dockerfile.worker baseline: $dockerfile_model" >&2
  echo "  src/providers/codex-models.ts CODEX_DEFAULT_MODEL: $ts_default" >&2
  exit 1
fi

dockerfile_version=$(grep -oE '^ARG CODEX_VERSION=[^[:space:]]+' "$DOCKERFILE" | head -1 | cut -d= -f2 || true)
package_version=$(cd "$ROOT" && bun -e 'const pkg = await Bun.file("package.json").json(); console.log(pkg.dependencies?.["@openai/codex"] ?? pkg.devDependencies?.["@openai/codex"] ?? "");')

if [ -z "$dockerfile_version" ] || [ -z "$package_version" ]; then
  echo "check-codex-default-model: failed to read CODEX_VERSION" >&2
  echo "  Dockerfile.worker ARG CODEX_VERSION: ${dockerfile_version:-<missing>}" >&2
  echo "  package.json @openai/codex: ${package_version:-<missing>}" >&2
  exit 1
fi

if [ "$dockerfile_version" != "$package_version" ]; then
  echo "check-codex-default-model: CODEX_VERSION MISMATCH" >&2
  echo "  Dockerfile.worker ARG CODEX_VERSION: $dockerfile_version" >&2
  echo "  package.json @openai/codex: $package_version" >&2
  exit 1
fi

echo "Codex pins check passed (model $dockerfile_model, codex $dockerfile_version)"
