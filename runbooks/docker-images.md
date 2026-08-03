# Docker image runbook

Rules and traps when editing `Dockerfile` (API) or `Dockerfile.worker` — especially anything that installs deps or writes to `/home/worker`.

## TL;DR — current baseline (2026-07-29)

| Image | Uncompressed | Built from |
|---|---:|---|
| `agent-swarm-worker` (full, `:latest`) | ~4.2 GB | `Dockerfile.worker` target `worker-full` (default) |
| `agent-swarm-worker` (`:slim`) | ~1.9 GB | `Dockerfile.worker` target `worker-slim` |
| `agent-swarm` (API) | ~380 MB | `Dockerfile` |

Compressed ghcr pull size ≈ 35–45 % of uncompressed.

CI tracks uncompressed amd64 sizes over time via the **ci-metrics** swarm script: merge-gate posts `image.api` + `image.worker-slim` per PR (sticky PR comment with a diff vs main), `docker-and-deploy.yml` posts all three (incl. `image.worker`) on main as the baseline. Contract + query examples: `agent-fs cat docs/ci-metrics.md`. The full worker is intrinsically heavy because it ships **four harnesses** (claude / pi / codex / opencode) + Playwright + a full dev toolchain. Don't chase further cuts without measuring with `docker history <img> --format "{{.Size}}\t{{.CreatedBy}}" | sort -h -r | head -10` first. Known irreducible chunk: `libllvm17t64` (~115 MB) is a hard `Depends:` of `postgresql-16` on Ubuntu 24.04 (NOT a recommends), and `libllvm20`+mesa (~180 MB) is a hard dep chain of `libgbm1`, which Chromium needs — both exist only in the full image.

## Stage map (`Dockerfile.worker`)

```
prek, builder            pinned prek binary + compiled agent-swarm binary
worker-base              minimal apt set + bun + ALL four harness CLIs +
                         context-mode CLI + npx-skills installs + base
                         /opt/global-deps (pm2, wts, agent-fs) + settings/ENVs
├─ worker-slim (target)  worker-base + leaf block. CI + E2E image.
└─ worker-full-base      + dev toolchain, glab, Playwright libs + chromium,
                         postgres/redis servers, /opt/global-deps-full
                         (qa-use, sentry-cli, localtunnel, claude-bridge),
                         context-mode claude+codex PLUGINS, qa-use skill
   └─ worker-full        worker-full-base + leaf block. Default; MUST stay the
      (target, LAST)     last stage so untargeted builds produce it.
```

Placement rules:

- **Code-dependent COPYs (the "leaf block") live ONLY in the two leaf stages**, duplicated verbatim and marked `KEEP IN SYNC`. Putting them in `worker-base` would invalidate every heavy `worker-full-base` layer on each `src/` edit.
- New heavy tool? Decide slim-vs-full deliberately: `worker-base` if the entrypoint or a harness needs it to boot, `worker-full-base` otherwise. If a tool is full-only and the entrypoint references it, guard the entrypoint with `command -v` (see the glab / postgres / redis guards in `docker-entrypoint.sh`).
- Full-only npm globals go in `/opt/global-deps-full` (separate staging dir) — never extend the base `/opt/global-deps` from `worker-full-base`, that rewrites its node_modules into a duplicate layer.

## Skills: `npx skills`, not plugin marketplaces

Only the CLI-coupled `agent-fs` skill (worker-base) and `qa-use` skill
(worker-full-base) are installed by pinned
`npx skills add <owner/repo>@<tag> --skill <name> -g -a claude-code -y` runs,
then mirrored into the pi/codex/opencode/.agents trees by the leaf block. The
general skill catalog, including vendored ai-toolbox skills, is DB-seeded from
`templates/skills/`. The ONLY remaining marketplace plugins are context-mode
for Claude + Codex (they ship the ctx_* hooks, which a skills-only installer
can't provide).

- Pin every source to a tag/SHA — unpinned `npx skills add` resolves the default branch at build time.
- Don't `|| true`-guard the skills RUN; keep the `test -e .../SKILL.md` asserts (upstream bug: global installs occasionally skip the `~/.claude/skills` link — vercel-labs/skills#851).
- Adding a plugin via `claude plugin install` again? It runs `bun install` under the hood — `rm -rf /home/worker/.bun/install/cache` in the SAME RUN (this was once an 880 MB layer), and expect the plugin cache to hold a full repo clone (the old agent-fs plugin was 778 MB for one skill — prefer `npx skills`).

## Build + measure

```bash
bun run docker:build:worker                                       # full -> agent-swarm-worker:latest
bun run docker:build:worker:slim                                  # slim -> agent-swarm-worker:slim
bun run docker:build:api                                          # API  -> agent-swarm-api:latest
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
  "dependencies": { "@desplega.ai/agent-fs": "0.7.2", ... },
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

`Dockerfile.worker` rebuilds happen via `bun run docker:build:worker` locally, and on every push to `main` via `.github/workflows/docker-and-deploy.yml` (which publishes `worker-full` as `:latest`/`:{VERSION}`/`:sha-*` AND `worker-slim` as `:slim`/`:{VERSION}-slim`/`:sha-*-slim`). PRs build only the `worker-slim` target in the merge gate. After local changes:

```bash
bun run docker:build:worker && bun run pm2-restart
```

See [ci.md](./ci.md) for the full Docker CI flow, and the docs-site "Published Artifacts" page for the consumer-facing inventory.
