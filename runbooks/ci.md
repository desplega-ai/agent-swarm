# CI runbook

**Run this checklist before pushing or opening a PR.** It mirrors what `.github/workflows/merge-gate.yml` runs on every PR — if anything here fails locally, CI will fail too.

## What CI runs

Three workflows live in `.github/workflows/`:

| Workflow | When | Purpose |
|---|---|---|
| `merge-gate.yml` | PR → `main` | **The gate.** All jobs below must pass for merge. |
| `ci.yml` | Push → `main` | Lint + tsc + test (subset of merge-gate). |
| `docker-and-deploy.yml` | Push → `main` | Build images (API + worker-full + worker-slim, each amd64+arm64 with multi-arch manifest merges; slim publishes as `:slim` / `:{VERSION}-slim` / `:sha-*-slim`), publish release E2B templates, deploy, and publish npm/GitHub releases (only when `package.json` `version` changed). Not part of PR gate — see [release.md](./release.md). |

Both PR-blocking workflows path-ignore `docs-site/**`. PRs that touch only those don't run code jobs (but Vercel deploys docs-site separately).

## Merge-gate jobs (PR → main)

CI detects what changed and runs the matching jobs:

### Always (when any non-`docs-site/` file changed)

| Job | Local equivalent | Common failure |
|---|---|---|
| **Lint and Type Check** | `bun run lint && bun run tsc:check && bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh && bash scripts/check-rbac-boundary.sh && bash scripts/check-audit-columns.sh && bun run check:dep-graph && bun run check:bun-version` | Worker code imported `bun:sqlite` or `src/be/db` — DB boundary violation (grep + dependency-cruiser graph rules); an inline `isLead` authz check in `src/tools/`/`src/http/` — RBAC boundary violation (use `can()` from `src/rbac/`); a new table without `created_by`/`updated_by` — add the columns or list the table in `.non-audit-tables` with a reason; or a Dockerfile `FROM oven/bun:<tag>` that does not match `package.json` `packageManager` |
| **Restore test timings** + **Run Tests (1/2, 2/2)** + **Save test timings** | `bun run test:root -- --parallel=4 --shard=1/2` and `--shard=2/2`. `restore-timings` resolves the latest per-file durations from the actions cache once and hands them to both shards as one artifact (two independent restores could pick different snapshots and split different file lists); `save-timings` merges the shards' `--update-timings` output into the next cache entry after a green matrix | New test or test that depends on undocumented setup; a hard-coded test port colliding under `--parallel` (use `getFreePort()` / `port: 0`, see [LOCAL_TESTING.md](../LOCAL_TESTING.md)) |
| **Pi-Skills Freshness** | `bun run build:pi-skills` (must produce zero diff in `plugin/pi-skills/`) | Edited `plugin/commands/*.md` without rebuilding |
| **Seeded Skills Check** | `bun run check:skill-sources && bun run check:ai-toolbox-skills && bun run check:skill-md && bun run check:seed-skill-files` | Edited a generated skill source without rebuilding its `SKILL.md`, drifted a vendored ai-toolbox skill from its manifest, left a seeded skill unwired, or introduced a delivery-path collision |
| **Script SDK Types Freshness** | `bun run check:script-types` (regenerates `src/scripts-runtime/types/*.d.ts`, must produce zero diff) | Edited `src/be/scripts/typecheck.ts` (the source of truth) without `bun run build:script-types`, or edited the generated `.d.ts` files directly (never do that) |
| **OpenAPI Spec Freshness** | `bun run docs:openapi` (must produce zero diff in `openapi.json` AND `docs-site/content/docs/api-reference/`) | Edited an HTTP route or bumped `package.json` `version` without regenerating |
| **Raw matchRoute check** | `! grep -rn 'matchRoute(' src/http/ --include='*.ts' \| grep -v 'route-def.ts' \| grep -v 'utils.ts'` | Used `matchRoute` directly instead of the `route()` factory |
| **Docker Build (Dockerfile + Dockerfile.worker slim target + apps/evals/Dockerfile)** | `docker build -f Dockerfile . && docker build -f Dockerfile.worker --target worker-slim . && docker build -f apps/evals/Dockerfile .` | Broken multi-stage build, missing file in the worker context, evals image drifting from the root workspace lockfile. NOTE: the PR gate builds only the worker's `worker-slim` target (fast); `worker-full` is only built on merge by `docker-and-deploy.yml` — if you touched full-only stages (`worker-full-base` / `worker-full`), build the full target locally before merging. The api + worker-slim legs also report uncompressed image sizes to the **ci-metrics** swarm script (sticky "Docker image sizes" PR comment diffing vs main; baseline refreshed by `docker-and-deploy.yml`'s `report-metrics` job; contract doc: `agent-fs cat docs/ci-metrics.md`; secret: `SWARM_CI_METRICS_TOKEN`). Reporting is `continue-on-error` — it can never block the gate |

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
bun run test:root -- --parallel=4          # CI splits this into --shard=1/2 and --shard=2/2
bun run check:bun-version
bash scripts/check-db-boundary.sh
bash scripts/check-api-key-boundary.sh
bash scripts/check-rbac-boundary.sh
bash scripts/check-audit-columns.sh
bun run check:rbac-coverage
bun run check:openapi-response-coverage
bun run check:dep-graph

# Drift checks (run if you touched the relevant files)
bun run build:pi-skills && git diff --quiet plugin/pi-skills/ || echo "pi-skills drift — commit the regenerated files"
bun run build:skill-md && git diff --quiet -- templates/skills/ || echo "generated SKILL.md drift — commit the regenerated files"
bun run docs:openapi    && git diff --quiet openapi.json docs-site/content/docs/api-reference/ || echo "openapi drift — commit the regenerated files"
bun run check:script-types || echo "script SDK types drift — run 'bun run build:script-types' and commit"

# Docker (if you touched any Dockerfile, apps/evals/, .dockerignore, bunfig.toml,
# root/member package.json, bun.lock, or anything the Dockerfiles COPY)
# PR gate builds the worker's slim target; build the full target too if you
# touched worker-full-base / worker-full stages.
docker build -f Dockerfile . && docker build -f Dockerfile.worker --target worker-slim . && docker build -f apps/evals/Dockerfile .

# ui (if you touched apps/ui/ — or root bun.lock/package.json/bunfig.toml, since ui deps resolve from the root lock)
( cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b )
```

## Why CI fails (in order of frequency)

1. **OpenAPI drift.** You touched a route or bumped `version` in `package.json` and forgot `bun run docs:openapi`. Both `openapi.json` AND `docs-site/content/docs/api-reference/**` need to be committed.
2. **Pi-skills drift.** You edited `plugin/commands/*.md` and forgot `bun run build:pi-skills`.
2b. **Generated skill drift.** You edited `templates/skills/<name>/content.md` or `config.json` and forgot `bun run build:skill-md`, or hand-edited its generated `SKILL.md`.
2c. **Script SDK types drift.** You edited `src/be/scripts/typecheck.ts` (or the SDK allowlist) and forgot `bun run build:script-types` — or you edited `src/scripts-runtime/types/*.d.ts` directly, which is never correct: those files are generated from `typecheck.ts`.
3. **Lockfile drift.** You ran `bun install` without `--frozen-lockfile` and got a different `bun.lock` than CI; CI uses `--frozen-lockfile` and rejects mismatches. Rule: when adding/upgrading deps, always commit `bun.lock`.
4. **DB boundary violation.** Worker-side code (`src/commands/`, `src/hooks/`, `src/providers/`, `src/prompts/`, `src/cli.tsx`, `src/claude.ts`) imported from `src/be/db` or `bun:sqlite`. See root CLAUDE.md "Architecture invariants".
5. **Raw `matchRoute()`.** Use the `route()` factory in `src/http/route-def.ts`.
6. **RBAC boundary violation.** An inline `isLead` authorization conditional in `src/tools/` or `src/http/` (DES-445). Authorization decisions must go through `can()` from `src/rbac/` (pattern: `src/tools/kv/kv-write-auth.ts`). Genuinely non-authz uses of `isLead` go in `ALLOWED_FILES` in `scripts/check-rbac-boundary.sh` with a reason.
7. **RBAC coverage failure.** You added an MCP tool file or a non-GET route without an explicit RBAC decision (DES-445). Tools: reach `can()` or add the file to `UNGATED_TOOL_FILES` in `scripts/check-rbac-coverage.ts` with a reason. Routes: put `rbac: { permission: "<verb>" }` or `rbac: { ungated: "<reason>" }` on the `route()` def. Stale allowlist/backlog entries also fail — delete them when a surface gains a gate.
7b. **OpenAPI response-coverage failure.** A `route()` def has a 2xx response (other than bodiless 204/205) with neither `schema: <zod>` nor `unstructured: "<reason>"` (`scripts/check-openapi-response-coverage.ts`). Declare the body shape and send it via the handle's typed `respond(res, code, data)`, or opt out with a real non-JSON reason (SSE/binary/redirect/proxy). The backlog file `scripts/.openapi-response-backlog` is empty and shrink-only — do not add to it.
8. **`tsc --noEmit` passed locally but `tsc -b` failed in ui.** The build-mode check catches project-reference issues `--noEmit` misses. Use `tsc -b` locally.
9. **Docker build cache mismatch.** Local Docker pulled a cached layer that CI doesn't have. Run `docker build --no-cache -f Dockerfile.worker .` if a clean local build is suspicious.
10. **Audit-column failure.** You added a migration creating a table without `created_by`/`updated_by` (`scripts/check-audit-columns.sh`). Add the columns, or register the table in `.non-audit-tables` with a comment naming where attribution actually lives.
11. **Tool classification failure.** You registered a new MCP tool without adding it to `CORE_TOOLS`/`DEFERRED_TOOLS` in `src/tools/tool-config.ts` (`src/tests/tool-annotations.test.ts` fails in `test:root`).
12. **Bun version pin drift.** You bumped `packageManager` in `package.json` (or one Dockerfile) without the others. `bun run check:bun-version` lists every pin that disagrees: `Dockerfile`, `Dockerfile.worker` (builder `FROM` + the runtime `bun.sh/install` pin), `apps/evals/Dockerfile`. CI installs whatever `packageManager` says (`setup-bun` with `bun-version-file: package.json`), so the pin IS the CI version.
13. **Test port collision under `--parallel`.** A test bound a literal port and another file in the same shard bound the same one; the loser reports `Server did not start within 60000ms` or `EADDRINUSE`. Use `listenOnFreePort()` / `getFreePort()` from `src/tests/test-net.ts`.
14. **Test spawnSync boundary violation.** A test called `Bun.spawnSync` / `spawnSync` / `execSync` / `execFileSync` (`scripts/check-test-spawn-sync.sh`). A blocked event loop cannot time a hung child out. Use `runChild()` / `expectChildOk()` from `src/tests/test-proc.ts` and pass `CHILD_PROCESS_TEST_BUDGET_MS` as the test's timeout argument.

## Bun version

`package.json` `packageManager` is the single source of truth. Bump it, then `bun run check:bun-version` tells you which Dockerfile pins to update; run `bun install --frozen-lockfile` on the new runtime to confirm it still accepts `bun.lock` (a lockfile-format change would surface here) and commit everything together. CI and the Docker images run exactly that version. `engines.bun` stays at the runtime floor the shipped CLI needs (`>=1.3.12`, text imports); `bun test --timings` / `--update-timings` and `bun pm licenses` are 1.4-only and only run in CI.

## GITHUB_TOKEN permissions

Every job in every workflow (`ci.yml`, `merge-gate.yml`, `migration-conflict-check.yml`, `docker-and-deploy.yml`, `helm-publish.yml`) declares its own `permissions:` block (CodeQL `actions/missing-workflow-permissions`). Most are `contents: read` (checkout only). Jobs with no checkout and no API calls (`restore-timings`, `save-timings`, `gate`) use `permissions: {}`. The ci-timings and ci-metrics reports use their own secrets, not `GITHUB_TOKEN`. `publish-mcp-registry.yml` and `star-history.yml` declare workflow-level permissions instead, because every job in each file needs the same scope. `docker-and-deploy.yml` and `helm-publish.yml` run only on `main` pushes and tags, so their per-job scopes cannot be proven on a PR; the next push to `main` is the functional check. When you add a job to any workflow: give it a per-job block (never a workflow-level one, which widens every job), and grant only what its steps use (`packages: write` for GHCR pushes, `pull-requests: write` for PR comments, `contents: write` for tag/release creation, `id-token: write` for OIDC-based publishing).

## Lockfile discipline

CI uses `bun install --frozen-lockfile`. A single root install now covers `apps/ui/`, `apps/templates-ui/`, and `apps/evals/` as Bun workspace members. This means:

- **Adding/upgrading a dep:** run `bun install <pkg>` (in the relevant workspace dir), then commit BOTH `package.json` AND the root `bun.lock`.
- **Cloning fresh / switching branches:** run `bun install --frozen-lockfile` to mirror CI. If it errors, the lockfile is stale — `bun install` (without `--frozen-lockfile`) and commit the result.
- **Never edit lockfiles by hand.**
- **Lockfile format:** `bun.lock` stays `lockfileVersion: 1`. Bun 1.4 writes v2 only for NEW lockfiles and keeps an existing v1 file as v1 on every write (verified: `bun add` + `bun remove` on 1.4.0 leaves the header untouched), and 1.4 reads v1 without complaint. Do not delete the lockfile to force v2: a fresh resolve bumps dependency versions. Nested or version-scoped `overrides` would move it to v3, which Bun < 1.4 cannot read.
- **Security fixes:** `bun audit` lists known-vulnerable versions in the lockfile and `bun audit fix` rewrites `bun.lock` to the nearest patched versions inside the declared ranges. Run it on a branch, then commit `bun.lock` like any other dep change.
- **Duplicate versions:** `bun dedupe --check` exits 1 when the lockfile holds removable duplicate versions. It **is** in the gate: the `lint-and-typecheck` job of both `ci.yml` and `merge-gate.yml` runs it right after `bun install`, and the `dedupe-check` pre-push hook mirrors it. The tree was deduped in #1222 (31 duplicates removed, which moved Biome to 2.4.5, `zod` to 4.4.3 and `openai` to 6.40.0). When a new dep reintroduces a duplicate, run `bun dedupe` and commit `bun.lock`. Because it re-resolves ranges it can move tool versions, so review the diff and re-run `bun run lint` plus `bun run tsc:check` before pushing.
- **Third-party licenses:** every GitHub release attaches `third-party-licenses.json` (`bun pm licenses --prod --json` from the `create-release` job).

## docs-site / templates-ui

`docs-site/` is path-ignored by `merge-gate.yml`, so PRs that touch only it won't run the code gate. But:

- **`docs-site/`** deploys via Vercel — `pnpm build` in `docs-site/` must pass. See [docs-site/CLAUDE.md](../docs-site/CLAUDE.md).
- **`apps/templates-ui/`** — same Vercel pattern.

Frontend-touching PRs additionally need a `qa-use` session with screenshots — see [testing.md](./testing.md).
