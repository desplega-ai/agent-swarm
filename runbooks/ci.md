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
| **Lint and Type Check** | `bun run lint && bun run tsc:check && bash scripts/check-db-boundary.sh && bash scripts/check-rbac-boundary.sh && bun run check:dep-graph` | Worker code imported `bun:sqlite` or `src/be/db` — DB boundary violation (grep + dependency-cruiser graph rules); or an inline `isLead` authz check in `src/tools/`/`src/http/` — RBAC boundary violation (use `can()` from `src/rbac/`) |
| **Run Tests** | `bun test` | New test or test that depends on undocumented setup |
| **Pi-Skills Freshness** | `bun run build:pi-skills` (must produce zero diff in `plugin/pi-skills/`) | Edited `plugin/commands/*.md` without rebuilding |
| **Script SDK Types Freshness** | `bun run check:script-types` (regenerates `src/scripts-runtime/types/*.d.ts`, must produce zero diff) | Edited `src/be/scripts/typecheck.ts` (the source of truth) without `bun run build:script-types`, or edited the generated `.d.ts` files directly (never do that) |
| **OpenAPI Spec Freshness** | `bun run docs:openapi` (must produce zero diff in `openapi.json` AND `docs-site/content/docs/api-reference/`) | Edited an HTTP route or bumped `package.json` `version` without regenerating |
| **Raw matchRoute check** | `! grep -rn 'matchRoute(' src/http/ --include='*.ts' \| grep -v 'route-def.ts' \| grep -v 'utils.ts'` | Used `matchRoute` directly instead of the `route()` factory |
| **Docker Build (Dockerfile + Dockerfile.worker + apps/evals/Dockerfile)** | `docker build -f Dockerfile . && docker build -f Dockerfile.worker . && docker build -f apps/evals/Dockerfile .` | Broken multi-stage build, missing file in the worker context, evals image drifting from the root workspace lockfile |

### When `apps/ui/` changed (or root `bun.lock` / `package.json` / `bunfig.toml`)

ui's dependency tree resolves from the **root** lockfile since the workspace migration, so root dep changes also trigger this job.

| Job | Local equivalent (run from `apps/ui/`) |
|---|---|
| **UI Lint and Type Check** | `bun install --frozen-lockfile && bun run lint && bunx tsc -b` |

> **Note:** CI uses `tsc -b` (project-references build mode), **not** `tsc --noEmit`. Use `tsc -b` locally to match.

## The full local pre-push command

Run this from the repo root before every push. It mirrors merge-gate exactly for the most common path (root code changes, possibly `apps/ui/`):

```bash
# Root project
bun install --frozen-lockfile
bun run lint            # NOT lint:fix — CI fails on warnings, not just errors
bun run tsc:check
bun test
bash scripts/check-db-boundary.sh
bash scripts/check-rbac-boundary.sh
bun run check:rbac-coverage
bun run check:dep-graph

# Drift checks (run if you touched the relevant files)
bun run build:pi-skills && git diff --quiet plugin/pi-skills/ || echo "pi-skills drift — commit the regenerated files"
bun run docs:openapi    && git diff --quiet openapi.json docs-site/content/docs/api-reference/ || echo "openapi drift — commit the regenerated files"
bun run check:script-types || echo "script SDK types drift — run 'bun run build:script-types' and commit"

# Docker (if you touched any Dockerfile, apps/evals/, .dockerignore, bunfig.toml,
# root/member package.json, bun.lock, or anything the Dockerfiles COPY)
docker build -f Dockerfile . && docker build -f Dockerfile.worker . && docker build -f apps/evals/Dockerfile .

# ui (if you touched apps/ui/ — or root bun.lock/package.json/bunfig.toml, since ui deps resolve from the root lock)
( cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b )
```

## Why CI fails (in order of frequency)

1. **OpenAPI drift.** You touched a route or bumped `version` in `package.json` and forgot `bun run docs:openapi`. Both `openapi.json` AND `docs-site/content/docs/api-reference/**` need to be committed.
2. **Pi-skills drift.** You edited `plugin/commands/*.md` and forgot `bun run build:pi-skills`.
2b. **Script SDK types drift.** You edited `src/be/scripts/typecheck.ts` (or the SDK allowlist) and forgot `bun run build:script-types` — or you edited `src/scripts-runtime/types/*.d.ts` directly, which is never correct: those files are generated from `typecheck.ts`.
3. **Lockfile drift.** You ran `bun install` without `--frozen-lockfile` and got a different `bun.lock` than CI; CI uses `--frozen-lockfile` and rejects mismatches. Rule: when adding/upgrading deps, always commit `bun.lock`.
4. **DB boundary violation.** Worker-side code (`src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`) imported from `src/be/db` or `bun:sqlite`. See root CLAUDE.md "Architecture invariants".
5. **Raw `matchRoute()`.** Use the `route()` factory in `src/http/route-def.ts`.
6. **RBAC boundary violation.** An inline `isLead` authorization conditional in `src/tools/` or `src/http/` (DES-445). Authorization decisions must go through `can()` from `src/rbac/` (pattern: `src/tools/kv/kv-write-auth.ts`). Genuinely non-authz uses of `isLead` go in `ALLOWED_FILES` in `scripts/check-rbac-boundary.sh` with a reason.
7. **RBAC coverage failure.** You added an MCP tool file or a non-GET route without an explicit RBAC decision (DES-445). Tools: reach `can()` or add the file to `UNGATED_TOOL_FILES` in `scripts/check-rbac-coverage.ts` with a reason. Routes: put `rbac: { permission: "<verb>" }` or `rbac: { ungated: "<reason>" }` on the `route()` def. Stale allowlist/backlog entries also fail — delete them when a surface gains a gate.
8. **`tsc --noEmit` passed locally but `tsc -b` failed in ui.** The build-mode check catches project-reference issues `--noEmit` misses. Use `tsc -b` locally.
9. **Docker build cache mismatch.** Local Docker pulled a cached layer that CI doesn't have. Run `docker build --no-cache -f Dockerfile.worker .` if a clean local build is suspicious.

## Lockfile discipline

CI uses `bun install --frozen-lockfile`. A single root install now covers `apps/ui/`, `apps/templates-ui/`, and `apps/evals/` as Bun workspace members. This means:

- **Adding/upgrading a dep:** run `bun install <pkg>` (in the relevant workspace dir), then commit BOTH `package.json` AND the root `bun.lock`.
- **Cloning fresh / switching branches:** run `bun install --frozen-lockfile` to mirror CI. If it errors, the lockfile is stale — `bun install` (without `--frozen-lockfile`) and commit the result.
- **Never edit lockfiles by hand.**

## docs-site / templates-ui

`docs-site/` is path-ignored by `merge-gate.yml`, so PRs that touch only it won't run the code gate. But:

- **`docs-site/`** deploys via Vercel — `pnpm build` in `docs-site/` must pass. See [docs-site/CLAUDE.md](../docs-site/CLAUDE.md).
- **`apps/templates-ui/`** — same Vercel pattern.

Frontend-touching PRs additionally need a `qa-use` session with screenshots — see [testing.md](./testing.md).
