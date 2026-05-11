# Docker image runbook

Rules and traps when editing `Dockerfile` (API) or `Dockerfile.worker` — especially anything that installs deps or writes to `/home/worker`.

## TL;DR — current baseline

| Image | Uncompressed | Compressed (ghcr) | Built from |
|---|---:|---:|---|
| `agent-swarm-worker` | ~5.8 GB | ~2.3 GB | `Dockerfile.worker` |
| `agent-swarm` (API) | ~450 MB | ~180 MB | `Dockerfile` |

The worker is intrinsically heavy because it ships **four harnesses** (claude / pi / codex / opencode) + Playwright + a full dev toolchain. Don't chase further cuts without measuring with `docker history <img> --format "{{.Size}}\t{{.CreatedBy}}" | sort -h -r | head -10` first.

## Build + measure

```bash
bun run docker:build:worker                                       # builds agent-swarm-worker:latest
docker images --format "{{.Repository}}:{{.Tag}} {{.Size}}" | grep agent-swarm
docker history agent-swarm-worker:latest --format "{{.Size}}\t{{.CreatedBy}}" \
  | awk -F'\t' '{ if ($1 ~ /[0-9]/ && $1 !~ /^0B/) print }' \
  | sort -h -r | head -10                                         # top layers by size
```

Inside the running image:

```bash
docker run --rm --entrypoint='' agent-swarm-worker:latest bash -c '
  du -sh /home/worker/.claude/plugins/cache/* /home/worker/.cache/* /home/worker/.npm /opt/global-deps/node_modules 2>/dev/null
'
```

## Hard rules

### 1. Never `chown -R /home/worker` in its own layer

A `RUN chown -R worker:worker /home/worker` placed AFTER the layer that filled `/home/worker` writes the **entire directory tree** to a new layer (Docker stores the changed metadata for every file). Previously this added a **5.17 GB** layer on its own — pure waste.

Fixes (in order of preference):

1. **Don't pollute /home/worker as root in the first place.** See rule 2.
2. If you must chown, do it **in the same `RUN`** as the install that created the bad ownership — the layer = final state, no duplication.
3. Never chown in a layer that has no other writes.

### 2. `ENV HOME=/home/worker` survives `USER root` — override it inline

The worker Dockerfile sets `ENV HOME=/home/worker` early (so the `worker` user's tools work). That ENV **persists across `USER root` switches**. Any `npm install`, `playwright install`, or curl-pipe-bash run under `USER root` will dump caches into `/home/worker/.{npm,cache,...}` as **root-owned files**, which then requires the chown layer described above.

When you need to install something as root:

```dockerfile
# Persist for runtime (Playwright reads this at runtime to find chromium):
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

# Override HOME + redirect caches inline, then clean them in the SAME RUN:
RUN HOME=/root NPM_CONFIG_CACHE=/tmp/npm-cache \
    sh -c 'cd /opt/global-deps && npm install --no-audit --no-fund \
      && qa-use install-deps' \
    && rm -rf /tmp/npm-cache /root/.npm /root/.cache
```

Caches to redirect or clean for common tools:

| Tool | Default cache location (under HOME) | Override / cleanup |
|---|---|---|
| npm | `~/.npm` | `NPM_CONFIG_CACHE=/tmp/npm-cache` + `rm -rf /tmp/npm-cache` |
| pnpm | `~/.local/share/pnpm/store` | `PNPM_HOME=/tmp/pnpm` + clean |
| Playwright | `~/.cache/ms-playwright` | `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright` (persistent — runtime reads it too) |
| Bun | `~/.bun/install/cache` | `BUN_INSTALL_CACHE_DIR=/tmp/bun-cache` + clean |
| pip | `~/.cache/pip` | `--no-cache-dir` flag, or `PIP_NO_CACHE_DIR=1` |
| Hugging Face / chonkie / transformers | `~/.cache/huggingface` | clean after install |
| Generic | `~/.cache/*` | `rm -rf /root/.cache` in the same RUN |

### 3. `npm overrides` only apply at the install root — not transitively via npm publish

This one bit us hard. If a monorepo's **root** `package.json` has `"overrides": { ... }`, those overrides **do not** travel with packages published from `packages/*` to npm. npm only honors `overrides` declared in the package.json **at the install root** (the one where you run `npm install`).

Concretely: setting `overrides` in `../agent-fs/package.json` (monorepo root) does nothing for `npm install -g @desplega.ai/agent-fs` in the worker image. The override has to live where the worker image actually runs `npm install` — i.e. **`/opt/global-deps/package.json`** inside `Dockerfile.worker`.

Pattern for stubbing a transitive bloater pulled in by some published dep:

```dockerfile
RUN cat > /opt/global-deps/package.json <<'EOF'
{
  "dependencies": { "@desplega.ai/agent-fs": "0.5.3", ... },
  "overrides": {
    "chromadb": "npm:empty-npm-package@1.0.0",
    "@xenova/transformers": "npm:empty-npm-package@1.0.0",
    "tree-sitter-wasms": "npm:empty-npm-package@1.0.0"
  }
}
EOF
```

`empty-npm-package@1.0.0` is a real npm package (~1 KB) that exports nothing — safe target for anything that's listed as an `optionalDependency` and never imported on the live code path. Before stubbing, **`grep` the consuming package's source** to confirm there's no eager top-level import of the package you're about to nuke.

### 4. Don't install Bun (or any toolchain) twice

The worker historically installed Bun once globally (`USER root`) and once for `worker` — ~200 MB duplicated. If you need a tool under both UIDs, install once to `/usr/local/bin` and rely on `PATH`. If a tool insists on living under `$HOME`, install it once and `chown` it to the right user in the **same** RUN.

### 5. Cleanup goes in the SAME `RUN` as the install

```dockerfile
# WRONG — cleanup lands in a separate layer, install layer still has the cache
RUN apt-get install -y foo
RUN rm -rf /var/lib/apt/lists/*

# RIGHT
RUN apt-get install -y foo \
    && rm -rf /var/lib/apt/lists/*
```

Same for `apt-get clean`, `rm -rf /usr/share/{doc,man}`, `npm cache clean --force`, etc.

## Anti-patterns to look for in PR review

- `RUN chown -R ... /home/worker` standalone
- `RUN npm install` without `--no-audit --no-fund` and without cache cleanup
- `curl ... | bash` as root with `HOME` unset (writes to `/home/worker` because of the global `ENV HOME=`)
- A new top-level dep being added to `/opt/global-deps/package.json` that pulls a vector DB / ML runtime — check `npm view <pkg> dependencies` and the transitive `optionalDependencies` chain before merging
- New `apt-get install` line without `&& rm -rf /var/lib/apt/lists/*` at the end of the SAME RUN

## Inspect a remote image without pulling

```bash
docker manifest inspect ghcr.io/desplega-ai/agent-swarm-worker:latest --verbose \
  | jq '.. | objects | .size? // empty' | sort -n | tail -10                   # biggest compressed layers
```

Compressed pull size ≈ 35–45 % of uncompressed on-disk size.

## When to bump the image

`Dockerfile.worker` rebuilds happen via `bun run docker:build:worker` locally, and on every push to `main` via `.github/workflows/docker-and-deploy.yml`. After local changes:

```bash
bun run docker:build:worker && bun run pm2-restart
```

See [ci.md](./ci.md) for the full Docker CI flow.
