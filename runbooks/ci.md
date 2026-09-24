# CI runbook

**Run this checklist before pushing or opening a PR.** It mirrors what `.github/workflows/merge-gate.yml` runs on every PR — if anything here fails locally, CI will fail too.

## What CI runs

The main workflows in `.github/workflows/`:

| Workflow | When | Purpose |
|---|---|---|
| `merge-gate.yml` | PR → `main` | **The gate.** All jobs below must pass for merge. |
| `pr-body.yml` | PR → `main` (opened, edited, reopened, synchronize, labeled, unlabeled). Merge queue. | **PR Body** check: the description must fill every required section of `.github/pull_request_template.md` (a `fix:` title adds Repro and Setup; Urgency needs exactly one checked box). Local equivalent: `bun scripts/check-pr-body.ts --title "<title>" --body-file <file>`. Fix by editing the title or description (no push needed). Skipped (reports success) for Dependabot, `release:` titles, the `skip-pr-body-check` label, and merge-queue entries. No path filter, so the check always reports. |
| `ci.yml` | Push → `main` | Lint + tsc + test (subset of merge-gate). |
| `ui-e2e.yml` | PR touching `apps/ui/`, `packages/ui-e2e/`, `scripts/e2e/`, `src/http/`, `src/be/`, `bun.lock`, `package.json`, `bunfig.toml`. Push → `main`. Nightly cron `0 3 * * *` UTC. Manual dispatch. | Playwright UI suite (`bun run e2e:ui`) in 2 shards against a seeded API per worker. Uploads artifacts to agent-fs and ingests into the UI E2E tracker for every same-repo event. **Informational**, not a required check: merged HTML report artifact (`ui-e2e-html-report`) plus one sticky PR comment (`<!-- ui-e2e -->`). See [LOCAL_TESTING.md § UI E2E](../LOCAL_TESTING.md#ui-e2e-bun-run-e2eui). |
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
| **Operator Skill Check** | `bun run check:operator-skill` | Missing public skill, invalid frontmatter, untracked GitHub target, or documentation URL without HTTP 200 after three HEAD attempts. Runs on every PR because any tracked target can disappear. Documentation outages can fail this check. |
| **Script SDK Types Freshness** | `bun run check:script-types` (regenerates `src/scripts-runtime/types/*.d.ts`, must produce zero diff) | Edited `src/be/scripts/typecheck.ts` (the source of truth) without `bun run build:script-types`, or edited the generated `.d.ts` files directly (never do that) |
| **OpenAPI Spec Freshness** | `bun run docs:openapi` (must produce zero diff in `openapi.json` AND `docs-site/content/docs/api-reference/`) | Edited an HTTP route or bumped `package.json` `version` without regenerating |
| **Raw matchRoute check** | `! grep -rn 'matchRoute(' src/http/ --include='*.ts' \| grep -v 'route-def.ts' \| grep -v 'utils.ts'` | Used `matchRoute` directly instead of the `route()` factory |
| **Docker Build (Dockerfile + Dockerfile.worker slim target + apps/evals/Dockerfile)** | `docker build -f Dockerfile . && docker build -f Dockerfile.worker --target worker-slim . && docker build -f apps/evals/Dockerfile .` | Broken multi-stage build, missing file in the worker context, evals image drifting from the root workspace lockfile. NOTE: the PR gate builds only the worker's `worker-slim` target (fast); `worker-full` is only built on merge by `docker-and-deploy.yml` — if you touched full-only stages (`worker-full-base` / `worker-full`), build the full target locally before merging. The api + worker-slim legs also report uncompressed image sizes to the **ci-metrics** swarm script (sticky "Docker image sizes" PR comment diffing vs main; baseline refreshed by `docker-and-deploy.yml`'s `report-metrics` job; contract doc: `agent-fs cat docs/ci-metrics.md`; secret: `SWARM_CI_METRICS_TOKEN`). Reporting is `continue-on-error` — it can never block the gate |

### When `apps/ui/` or `packages/ui-e2e/` changed (or root `bun.lock` / `package.json` / `bunfig.toml`)

ui's dependency tree resolves from the **root** lockfile since the workspace migration, so root dep changes also trigger this job.

| Job | Local equivalent (run from `apps/ui/`) |
|---|---|
| **UI Lint and Type Check** | `bun install --frozen-lockfile && bun run lint && bunx tsc -b`, then from the repo root `bun run e2e:ui:tsc && bunx biome check packages/ui-e2e` |

> **Note:** CI uses `tsc -b` (project-references build mode), **not** `tsc --noEmit`. Use `tsc -b` locally to match.

### ui-e2e.yml secrets and variables

| Name | Kind | Owner | Feeds | When absent |
|---|---|---|---|---|
| `E2E_AGENT_FS_API_URL` | secret | Taras | agent-fs upload of screenshots and traces | Uploads skipped, comment stays text-only |
| `E2E_AGENT_FS_API_KEY` | secret | Taras | agent-fs upload | Uploads skipped, comment stays text-only |
| `E2E_AGENT_FS_ORG_ID` | secret | Taras | agent-fs upload target org | Uploads skipped, comment stays text-only |
| `E2E_AGENT_FS_DRIVE_ID` | secret | Taras | agent-fs upload target drive | Uploads skipped, comment stays text-only |
| `UI_E2E_INGEST_URL` | secret | Taras | tracker ingest endpoint | Ingest skipped |
| `UI_E2E_INGEST_BEARER` | secret | Taras | tracker ingest bearer | Ingest skipped |
| `UI_E2E_TRACKER_URL` | repository variable | Taras | sticky comment tracker link | No tracker link in the comment |

## HOL plugin scanner

[`plugin-scanner.yml`](../.github/workflows/plugin-scanner.yml) runs on pushes and
pull requests with read-only repository access. It pins HOL's Action to
`46ad86451b45941cd853a03ee6ccdb55f3dbee28` (v1.2.683), which installs
`plugin-scanner==3.0.181` with a verified wheel digest, PyPI provenance, and locked
runtime dependencies. The job summary reports the score; its
`plugin-scanner-report` artifact contains every finding as JSON for 30 days.

The scan is advisory while findings are reviewed. `min_score: 0` allows report
collection below the HOL catalog maintainer's **80/100** threshold; a green job
does not mean the plugin qualifies for listing. Installation, scanning, and
artifact failures still fail the job. PR comments, submissions, network-enabled
analysis, SARIF upload, and repository-owned suppressions are disabled. The
optional Cisco analyzer is not installed by the Action's default installation.

### Scope and baseline

The default profile at repository root reproduced the catalog's **52/100** on
`c3da9506891abcd4d095626734118526e602109e`: 675 high, 20 medium, 5 low, and 5
informational findings. Auto-detection found Claude, Codex, Gemini, and Kimi
packages sharing that root. Claude, Codex, and Gemini each run the common checks
over the monorepo, so most findings occur three times.

After pinning the two actions, the same local scan scores **57/100** with 699
findings: 675 high, 14 medium, 5 low, and 5 informational. Exactly six
`GITHUB_ACTION_UNPINNED` findings disappear; no findings are added or suppressed.
The catalog threshold remains unmet.

| Rule | Findings before action pinning | Severity | Paths / interpretation |
|---|---:|---|---|
| `HARDCODED_SECRET` | 636 | high | 212 locations, each reported three times: 185 in tests/fixtures, 10 in docs/history, 17 elsewhere. These counts classify paths, not whether a credential is real. |
| `DANGEROUS_DYNAMIC_EXECUTION` | 27 | high | Nine matches across seven files, including `src/workflows/wait-filter.ts`, `src/workflows/executors/code-match.ts`, and test/smoke fixtures. |
| `SHELL_INJECTION_PATTERN` | 9 | high | `src/commands/codex-login.ts`, `src/utils/internal-ai/complete-structured.ts`, `src/tests/package-publish.test.ts`. Requires review of inputs and actual process APIs. |
| `RISKY_APPROVAL_DEFAULT` | 9 | medium | `src/be/seed-skills/bundled-files.generated.json` and two historical plans under `thoughts/taras/plans/`. |
| `GITHUB_ACTION_UNPINNED` | 6 | medium | Two refs in `merge-gate.yml`, each reported three times. Both are now pinned. |
| `SECURITY_MD_MISSING` | 4 | low | Root `SECURITY.md`, reported once per ecosystem. |
| `GITHUB_ACTIONS_UNTRUSTED_CHECKOUT` | 3 | high | `slack-visuals-publish.yml`: the scanner searches the whole file for a trigger, checkout, and head-ref expression without connecting the expression to a checkout step. This workflow deliberately checks out the base branch. |
| `DEPENDENCY_LOCKFILE_MISSING` | 3 | medium | Root `pyproject.toml`, a deployment cache workaround with no declared Python dependencies. |
| `MARKETPLACE_SOURCE_INVALID` | 1 | medium | `.agents/plugins/marketplace.json`. |
| `MARKETPLACE_UNSAFE_SOURCE` | 1 | medium | `.agents/plugins/marketplace.json`. |
| `KIMI_INTERFACE_INVALID` | 1 | low | Scanner reports `plugin.json`; the actual manifest is `.kimi-plugin/plugin.json`. |
| `PLUGIN_JSON_INTERFACE_ASSET_PRIVACYPOLICYURL` | 1 | info | `.codex-plugin/plugin.json`. |
| `PLUGIN_JSON_INTERFACE_ASSET_TERMSOFSERVICEURL` | 1 | info | `.codex-plugin/plugin.json`. |
| `PLUGIN_JSON_INTERFACE_ASSET_COMPOSERICON` | 1 | info | `.codex-plugin/plugin.json`. |
| `PLUGIN_JSON_INTERFACE_ASSET_SCREENSHOTS` | 1 | info | `.codex-plugin/plugin.json`. |
| `CODEXIGNORE_MISSING` | 1 | info | Root `.codexignore`. |

Keep `plugin_dir: .` for catalog comparability. Pointing only at `skills/` would
omit manifests, referenced assets, and repository workflows. This scanner's
baseline suppresses entire rule IDs; `ignore_paths` suppresses all findings in
matching paths. Neither justifies hiding all server code or all secret findings
before reviewing them. Any later scoped report must document the installable
package boundary and retain the full repository report for comparison.

To inspect a downloaded report without counting nested copies twice:

```bash
jq '.summary.findings, {score, raw_score, effective_score, ecosystems}' plugin-scanner.json
jq '.findings | group_by(.ruleId) | map({rule: .[0].ruleId, count: length}) | sort_by(-.count)' plugin-scanner.json
jq -r '.findings[] | [.ruleId, .severity, .filePath, (.lineNumber // "")] | @tsv' plugin-scanner.json
```

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
bun run check:operator-skill

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

Every job in every workflow (`ci.yml`, `merge-gate.yml`, `migration-conflict-check.yml`, `docker-and-deploy.yml`, `helm-publish.yml`) declares its own `permissions:` block (CodeQL `actions/missing-workflow-permissions`). Most are `contents: read` (checkout only). Jobs with no checkout and no API calls (`restore-timings`, `save-timings`, `gate`) use `permissions: {}`. The ci-timings and ci-metrics reports use their own secrets, not `GITHUB_TOKEN`. `publish-mcp-registry.yml` declares workflow-level permissions instead, because every job in it needs the same scope. `docker-and-deploy.yml` and `helm-publish.yml` run only on `main` pushes and tags, so their per-job scopes cannot be proven on a PR; the next push to `main` is the functional check. When you add a job to any workflow: give it a per-job block (never a workflow-level one, which widens every job), and grant only what its steps use (`packages: write` for GHCR pushes, `pull-requests: write` for PR comments, `contents: write` for tag/release creation, `id-token: write` for OIDC-based publishing).

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

Frontend-touching PRs additionally need `agent-browser` screenshots uploaded to agent-fs (reviewer convention, not a CI job). See [testing.md](./testing.md).
