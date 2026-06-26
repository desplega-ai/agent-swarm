#!/usr/bin/env bash

repo_dir="${1:-}"
repo_name="${2:-$repo_dir}"

warn() {
  echo "  Warning: $*" >&2
}

if [ -z "$repo_dir" ]; then
  warn "install-repo-hooks called without a repo path"
  exit 0
fi

if [ ! -d "$repo_dir/.git" ]; then
  warn "Skipping hook install for ${repo_name}: ${repo_dir} is not a git checkout"
  exit 0
fi

echo "  Installing git hooks for ${repo_name}..."

configured_hooks_path="$(git -C "$repo_dir" config --get core.hooksPath 2>/dev/null || true)"
if [ -n "$configured_hooks_path" ]; then
  echo "    Native hooks already configured at ${configured_hooks_path}"
elif [ -d "$repo_dir/.githooks" ]; then
  if git -C "$repo_dir" config core.hooksPath .githooks; then
    echo "    Configured native hooks path: .githooks"
  else
    warn "Could not configure core.hooksPath for ${repo_name}"
  fi
fi

if [ -f "$repo_dir/.pre-commit-config.yaml" ]; then
  if command -v prek >/dev/null 2>&1; then
    if (cd "$repo_dir" && prek install); then
      echo "    Installed prek git shims"
    else
      warn "prek install failed for ${repo_name}"
    fi
  else
    warn "prek is not installed; cannot install .pre-commit-config.yaml hooks for ${repo_name}"
  fi
fi

if [ -d "$repo_dir/.husky" ]; then
  if command -v npm >/dev/null 2>&1; then
    if (cd "$repo_dir" && npm install); then
      echo "    Ran npm install for Husky setup"
    else
      warn "npm install failed for Husky setup in ${repo_name}"
    fi
  else
    warn "npm is not installed; cannot install Husky hooks for ${repo_name}"
  fi
fi

exit 0
