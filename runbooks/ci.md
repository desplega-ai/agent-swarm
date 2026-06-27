# CI runbook

**Run this checklist before pushing or opening a PR.** It mirrors what `.github/workflows/merge-gate.yml` runs on every PR — if anything here fails locally, CI will fail too.

## What CI runs

Three workflows live in `.github/workflows/`:

| Workflow | When | Purpose |
|---|---|---|
| `merge-gate.yml` | PR → `main` | **The gate.** All jobs below must pass for merge. |
| `ci.yml` | Push → `main` | Lint + tsc + test (subset of merge-gate). |
| `docker-and-deploy.yml` | Push → `main` | Build images, publish release E2B templates, deploy, and publish npm/GitHub releases (only when `package.json` `version` changed). Not part of PR gate — see [release.md](./release.md). |

Both PR-blocking workflows path-ignore `docs-site/**`. PRs that touch only those don't run code jobs (but Vercel deploys docs-site separately).

## Merge-gate jobs (PR → main)

CI detects what changed and runs the matching jobs:

### Always (when any non-`docs-site/` file changed)

| Job | Local equivalent | Common failure |
|---|---|---|
| **Lint and Type Check** | `bun run lint && bun run tsc:check && bash scripts/check-db-boundary.sh` | Worker code imported `bun:sqlite` or `src/be/db` — DB boundary violation |
| **Run Tests** | `bun test` | New test or test that depends on undocumented setup |
| **Pi-Skills Freshness** | `bun run build:pi-skills` (must produce zero diff in `plugin/pi-skills/`) | Edited `plugin/commands/*.md` without rebuilding |
| **OpenAPI Spec Freshness** | `bun run docs:openapi` (must produce zero diff in `openapi.json` AND `docs-site/content/docs/api-reference/`) | Edited an HTTP route or bumped `package.json` `version` without regenerating |
| **Raw matchRoute check** | `! grep -rn 'matchRoute(' src/http/ --include='*.ts' \| grep -v 'route-def.ts' \| grep -v 'utils.ts'` | Used `matchRoute` directly instead of the `route()` factory |
| **Docker Build (Dockerfile + Dockerfile.worker)** | `docker build -f Dockerfile . && docker build -f Dockerfile.worker .` | Broken multi-stage build, missing file in the worker context |

### When `ui/` changed

| Job | Local equivalent (run from `ui/`) |
|---|---|
| **UI Lint and Type Check** | `bun install --frozen-lockfile && bun run lint && bunx tsc -b` |

> **Note:** CI uses `tsc -b` (project-references build mode), **not** `tsc --noEmit`. Use `tsc -b` locally to match.

## The full local pre-push command

Run this from the repo root before every push. It mirrors merge-gate exactly for the most common path (root code changes, possibly `ui/`):

```bash
# Root project
bun install --frozen-lockfile
bun run lint            # NOT lint:fix — CI fails on warnings, not just errors
bun run tsc:check
bun test
bash scripts/check-db-boundary.sh

# Drift checks (run if you touched the relevant files)
bun run build:pi-skills && git diff --quiet plugin/pi-skills/ || echo "pi-skills drift — commit the regenerated files"
bun run docs:openapi    && git diff --quiet openapi.json docs-site/content/docs/api-reference/ || echo "openapi drift — commit the regenerated files"

# Docker (only if you touched Dockerfile, Dockerfile.worker, or anything they COPY)
docker build -f Dockerfile . && docker build -f Dockerfile.worker .

# ui (only if you touched ui/)
( cd ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b )
```

## Why CI fails (in order of frequency)

1. **OpenAPI drift.** You touched a route or bumped `version` in `package.json` and forgot `bun run docs:openapi`. Both `openapi.json` AND `docs-site/content/docs/api-reference/**` need to be committed.
2. **Pi-skills drift.** You edited `plugin/commands/*.md` and forgot `bun run build:pi-skills`.
3. **Lockfile drift.** You ran `bun install` without `--frozen-lockfile` and got a different `bun.lock` than CI; CI uses `--frozen-lockfile` and rejects mismatches. Rule: when adding/upgrading deps, always commit `bun.lock`.
4. **DB boundary violation.** Worker-side code (`src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`) imported from `src/be/db` or `bun:sqlite`. See root CLAUDE.md "Architecture invariants".
5. **Raw `matchRoute()`.** Use the `route()` factory in `src/http/route-def.ts`.
6. **`tsc --noEmit` passed locally but `tsc -b` failed in ui.** The build-mode check catches project-reference issues `--noEmit` misses. Use `tsc -b` locally.
7. **Docker build cache mismatch.** Local Docker pulled a cached layer that CI doesn't have. Run `docker build --no-cache -f Dockerfile.worker .` if a clean local build is suspicious.

## Lockfile discipline

CI uses `bun install --frozen-lockfile`. A single root install now covers `ui/`, `templates-ui/`, and `evals/` as Bun workspace members. This means:

- **Adding/upgrading a dep:** run `bun install <pkg>` (in the relevant workspace dir), then commit BOTH `package.json` AND the root `bun.lock`.
- **Cloning fresh / switching branches:** run `bun install --frozen-lockfile` to mirror CI. If it errors, the lockfile is stale — `bun install` (without `--frozen-lockfile`) and commit the result.
- **Never edit lockfiles by hand.**

## docs-site / templates-ui

`docs-site/` is path-ignored by `merge-gate.yml`, so PRs that touch only it won't run the code gate. But:

- **`docs-site/`** deploys via Vercel — `pnpm build` in `docs-site/` must pass. See [docs-site/CLAUDE.md](../docs-site/CLAUDE.md).
- **`templates-ui/`** — same Vercel pattern.

Frontend-touching PRs additionally need a `qa-use` session with screenshots — see [testing.md](./testing.md).
