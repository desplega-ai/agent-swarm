# Baked Skills to Database Seeding Implementation Plan

## Overview

Move the remaining repository-owned and pinned ai-toolbox skills from worker-image installation into the existing database seeder, while making worker startup fail clearly when the API or its required seed catalog never becomes ready. The work is split into three separately reviewable PRs; Phases 1 and 2 are deploy-safe in either order, while Phase 3 intentionally builds on Phase 1's generated-catalog foundation. The collision and multi-file foundation described as Phase 0 in the research is already shipped in PR #1044 and is not planned again here.

- **Motivation**: collapse parallel skill delivery paths, make skill updates reproducible and live-updatable, and prevent workers from starting half-provisioned when their control-plane API is unavailable. This is an update-velocity and correctness project, not an image-size or boot-speed optimization.
- **Related**: [`thoughts/taras/research/2026-07-31-baked-skills-to-db-seeding.md`](../../taras/research/2026-07-31-baked-skills-to-db-seeding.md), [PR #1044](https://github.com/desplega-ai/agent-swarm/pull/1044), `runbooks/skills.md`, `runbooks/docker-images.md`, `LOCAL_TESTING.md`

## Current State Analysis

### Phase 0 already shipped in PR #1044

PR #1044 (`f11c601a`, merged 2026-07-31) completed the research document's Phase 0. It removed the baked `artifacts`, `kv-storage`, and `pages` collisions; reconciled their content under `templates/skills/`; moved/added their examples under `files/`; generated `bundled-files.generated.json`; made bundled files part of drift detection; atomically synchronizes and prunes `skill_files`; and added regression coverage for legacy DB upgrades and repeated filesystem reconciliation (`src/be/seed-skills/index.ts:83`, `src/be/seed-skills/index.ts:133`, `src/be/seed-skills/index.ts:256`, `src/be/seed-skills/index.ts:299`, `src/tests/seed-skills-bundled-files.test.ts:61`). Nothing remains undone inside that Phase 0 scope.

It intentionally left the later phases untouched: the production source catalog remains static, five `plugin/skills/` directories remain baked, the two leaf-stage Docker mirrors remain, there is no API-readiness gate, and ai-toolbox is still installed during the worker build.

### Seeder and source catalog

- The production seeder now supports both simple and multi-file skills and applies the skill row plus its files transactionally (`src/be/seed-skills/index.ts:83-114`, `src/be/seed-skills/index.ts:275-341`).
- `loadSeedSkills(templatesDir)` already discovers directories for tests and the seed CLI, but the no-argument production branch still reads 20 static text imports and the 10-entry `BUILT_IN_SKILL_SOURCES` array (`src/be/seed-skills/index.ts:11-62`, `src/be/seed-skills/index.ts:116-127`, `src/be/seed-skills/index.ts:203-253`). Production cannot scan `templates/` at runtime because the API is a compiled binary and the templates directory exists only during the builder stage.
- `scripts/check-skill-sources.ts` currently parses those imports and that array to enforce wiring (`scripts/check-skill-sources.ts:70-80`, `scripts/check-skill-sources.ts:133-179`). Any discovery change must update this check rather than leaving a silently obsolete regex.
- The generated bundled-file manifest and dedicated Seeded Skills CI job already provide a pattern for deterministic build-time discovery and drift checks (`scripts/build-seed-skill-files.ts:43-90`, `.github/workflows/merge-gate.yml:84-99`, `.github/workflows/merge-gate.yml:248-275`).

### Remaining baked sources

- `plugin/skills/` now contains exactly five real skill directories: `composio`, `composio-gmail`, `composio-google-calendar`, `composio-google-docs`, and `download-task-attachment`.
- `composio` is also a remote-install recommendation. Its integration catalog entry still points at `plugin/skills/composio` (`apps/ui/src/lib/integrations-catalog.ts:675-695`), so its migrated template must retain a sibling `SKILL.md` and the catalog/docs path must move with it.
- `Dockerfile.worker` copies `plugin/skills/` in both leaf stages (`Dockerfile.worker:389-392`, `Dockerfile.worker:607-610`) and generically mirrors every Claude-installed skill into the other four harness trees (`Dockerfile.worker:410-422`, `Dockerfile.worker:628-640`). The mirror currently carries not just `plugin/skills/`, but also `agent-fs`, all 18 ai-toolbox skills, and full-image `qa-use`.
- `agent-fs` is deliberately version-locked to its CLI via `AGENT_FS_VERSION` (`Dockerfile.worker:218-231`, `Dockerfile.worker:287-320`), and `qa-use` remains a full-image-only pinned install (`Dockerfile.worker:581-586`). They must remain baked and available to all harnesses after the generic mirror is removed.
- `plugin/commands/` and `plugin/agents/` remain image artifacts. Commands have per-harness transformed content, and neither commands nor agent definitions have a DB surface.

### Worker boot

- `docker-entrypoint.sh` performs API reads before and throughout setup, but all current failures are best-effort; skill sync explicitly continues when no response arrives (`docker-entrypoint.sh:58-76`, `docker-entrypoint.sh:126-166`, `docker-entrypoint.sh:284-308`, `docker-entrypoint.sh:327-369`, `docker-entrypoint.sh:706-754`).
- The canonical public process-readiness endpoint is `GET /health`, not `/api/health` (`src/http/core.ts:289-305`). It is not a seed-catalog compatibility proof: startup catches built-in seeder errors and continues toward `listen()` (`src/http/index.ts:542-553`), and an older API can return 200 without containing the five migrated skills.
- `ROLE` and `MCP_URL` are currently resolved too late for a gate that must precede the earliest provider-specific API reads (`docker-entrypoint.sh:252-255`).

### ai-toolbox installation

- `worker-base` installs 18 skills from `desplega-ai/ai-toolbox@cc-desplega-2.0.0` during the image build (`Dockerfile.worker:206-231`). The tag resolves to commit `678ef856b53d036855cf65eabe835280909be135`.
- Seventeen source skills live under `cc-plugin/base/skills/`; `wts-expert` lives under `cc-plugin/wts/skills/`. Ten skills have 14 auxiliary files that must become seeded `files/` content rather than being dropped.
- Four upstream skills (`implementing`, `phase-running`, `step-running`, `v-implementing`) declare Claude plugin `hooks:` metadata referencing files outside their skill directories. The current DB skill schema and renderer support only `name`, `description`, body content, and bundled files (`src/be/seed-skills/index.ts:76-97`, `src/be/seed-skills/index.ts:129-131`).

## Corrections to the Research Doc

1. The “simple skills only” and missing multi-file seeder gaps are obsolete. PR #1044 shipped multi-file discovery, hashing, transactional DB writes, pruning, generated-file embedding, and repeated-refresh regression coverage.
2. `plugin/skills/` no longer contains eight skills or any collisions. It contains the five baked-only skills named above plus `.gitkeep`.
3. Directory discovery already exists in the explicit `loadSeedSkills(templatesDir)` disk path, but not in the compiled production path. Phase 1 must use deterministic build-time discovery/embedding, not runtime scanning of a directory absent from the API image.
4. The research points at `/api/health`; the current endpoint is public `GET /health`.
5. The entrypoint's boot sync directly writes simple skills only to Claude, Pi, and Codex. All-five-tree convergence is provided by the runner-side live refresh (`docker-entrypoint.sh:706-751`, `src/utils/skills-refresh.ts:113-181`, `src/utils/skill-fs-writer.ts:121-137`).
6. The four directories with both `content.md` and `SKILL.md` are not dead weight. PR #1044 deliberately documented seeded and remote-install sources as legitimate siblings (`runbooks/skills.md:17`), and `scripts/check-skill-sources.ts:181-201` verifies that catalog remote paths have a real `SKILL.md`. It does not enforce byte equality, because the two surfaces may intentionally differ. The proposed cleanup is dropped from this plan rather than expanding these phases into unrelated content reconciliation.
7. Removing the generic Docker mirror without changing installer targeting would break retained baked skills on non-Claude harnesses. Phase 1 therefore pairs mirror removal with explicit all-agent installs and per-tree assertions for `agent-fs`, ai-toolbox, and `qa-use`; Phase 3 later removes only ai-toolbox.

## Desired End State

- The five repository-owned skills exist only under `templates/skills/`, seed at swarm scope, retain their existing content, and are delivered by DB refresh to Claude, Pi, Codex, OpenCode, and the universal Agents tree.
- The compiled production catalog is generated deterministically from `templates/skills/*/config.json` and `content.md`; adding a seeded template requires regeneration, not hand-written imports.
- The Phase-1 worker image removes its repository-skill fallback only after it can prove the reachable API advertises the additive `repository-skills-v1` seed capability and has completed the corresponding seed run; an old healthy or seed-incomplete API makes the worker exit non-zero before the runner starts.
- Worker and lead containers also poll `${MCP_BASE_URL}/health` before any API-dependent setup, stop waiting after a validated timeout, and exit non-zero with a stable non-secret fatal message when the API remains unavailable. This Phase-2 liveness gate complements rather than replaces the Phase-1 catalog-capability gate.
- The pinned 18-skill ai-toolbox snapshot lives under `templates/skills/`, including its 14 supported auxiliary files, with a non-interactive sync/check script and CI drift gate.
- Worker images no longer run the ai-toolbox `npx skills add` block or copy repository skills, while `agent-fs`, `qa-use`, `plugin/commands/`, and `plugin/agents/` retain their intended baked delivery.
- Phase 1 is rollout-safe without Phase 2, Phase 2 is rollout-safe without Phase 1, and Phase 3 lands only after Phase 1 because it consumes the generated catalog.

## What We're NOT Doing

- Reimplementing or modifying PR #1044's Phase 0 work.
- Moving `plugin/commands/`, `plugin/pi-skills/`, or `plugin/agents/` into the DB.
- Migrating `agent-fs` or `qa-use`; Option D remains rejected because skill/CLI version skew is unsafe.
- Moving the context-mode plugin marketplace installation; it supplies hooks, not only skills.
- Fetching skill sources at API boot or worker boot.
- Treating image size or boot speed as a success metric; the research showed neither is the motivation.
- Reconciling the existing dual `content.md`/`SKILL.md` templates outside the Composio path move required by Phase 1.
- Merging any implementation PR as part of this plan.

## Implementation Approach

- Land three PRs corresponding exactly to Phases 1-3 below. Phase 2 is independent and may land before or after Phase 1; Phase 3 follows Phase 1.
- Make Phase 1 the catalog-discovery foundation. Use a generated, checked catalog artifact so the compiled binary embeds discovered sources without a runtime templates dependency.
- Give Phase 1 its own additive catalog contract. The API reports `repository-skills-v1` only after the current process finishes a failure-free skill seed and verifies the five required DB rows; the worker requires that capability before starting. Do not infer catalog compatibility from `/health`.
- Preserve delivery parity before deleting image fanout: the pinned installer must copy retained baked skills to all supported agent targets, with assertions on the five paths the swarm actually uses.
- Treat vendoring as a reproducible transformation: explicit upstream paths and pin, staged writes, strict validation, deterministic output, and a `--check` mode.
- Keep verification evidence inside each PR. Fresh/existing-DB coverage is implemented as isolated test fixtures that create unique temporary SQLite files and remove the `.sqlite`, `-wal`, and `-shm` files in `afterAll`; no implementation gate deletes the default development DB.
- Put each deployment scenario behind a committed package command and wire it into the relevant Merge Gate change detector. A checklist item is not complete when a human has only observed logs or queried SQLite ad hoc.

## Quick Verification Reference

Common repository gates for all three implementation PRs:

```bash
bun install --frozen-lockfile
bun run lint
bun run tsc:check
bun run test:root
bash scripts/check-db-boundary.sh
bun run check:dep-graph
```

Skill-affecting phases additionally run:

```bash
bun run check:skill-sources
bun run check:seed-skill-files
bun run test:root -- src/tests/seed-skills-bundled-files.test.ts src/tests/system-default-skills.test.ts src/tests/skill-fs-writer.test.ts src/tests/skill-sync.test.ts
bun run docker:build:worker:slim
bun run docker:build:worker
```

---

## Phase 1: Migrate Repository-owned Baked Skills and Discover the Seed Catalog

### Overview

Deliver a compiled, generated seed catalog containing the five formerly baked repository skills, an API proof that the catalog was seeded successfully, and a fail-closed worker check for that proof before removing image copies and generic leaf-stage mirrors. Preserve all-harness delivery of the intentionally retained baked dependencies. This phase is one independently deploy-safe PR even when Phase 2 has not landed.

### Changes Required:

#### 1. Convert the five baked skills into seeded templates

**Files**: `plugin/skills/{composio,composio-gmail,composio-google-calendar,composio-google-docs,download-task-attachment}/SKILL.md`, `templates/skills/<same names>/config.json`, `templates/skills/<same names>/content.md`

**Changes**:

- Parse each existing `SKILL.md` frontmatter into a static `config.json`; move the body without frontmatter into `content.md` without rewriting its operational guidance.
- Set `runAllSeedersCandidate: true`. Set `systemDefault: true` to preserve the current unconditional baked visibility; scope remains `swarm` through the seeder.
- Delete the five old `plugin/skills/` directories after the template source exists. Retain `.gitkeep` only if the directory itself must continue to exist for tooling; otherwise remove the now-empty directory and update tooling to tolerate absence.
- For `composio`, retain a one-time migrated `templates/skills/composio/SKILL.md` as the remote-install artifact so the integration path does not 404. Preserve its content during the move; do not introduce a new cross-surface parity policy in this phase.

#### 2. Replace static production wiring with build-time directory discovery

**Files**: `scripts/build-seed-skill-catalog.ts` (new), `src/be/seed-skills/catalog.generated.json` (new), `src/be/seed-skills/index.ts`, `package.json`, `scripts/check-skill-sources.ts`, `scripts/build-seed-skill-files.ts`

**Changes**:

- Add a Bun generator that scans `templates/skills/*/config.json`, validates directory/name/body rules, filters `runAllSeedersCandidate: true`, reads `content.md`, sorts by skill name, and writes a deterministic embedded catalog containing config plus body text. Include an additive `capabilities` array whose first migration marker is `repository-skills-v1`; later catalog additions append capabilities rather than changing the meaning of this marker.
- Support `--check` and add paired package commands (for example, `build:seed-skill-catalog` and `check:seed-skill-catalog`). Never make production `loadSeedSkills()` depend on filesystem scanning.
- Replace the 20 static imports and hand-written `BUILT_IN_SKILL_SOURCES` list with one generated JSON import. Preserve the current explicit disk-loader branch for tests and the separate bundled-file manifest unless a focused refactor proves a single combined generated artifact is simpler without weakening the #1044 hash/upgrade tests.
- Rewrite `check-skill-sources.ts` so it compares all seed-candidate template directories with the generated catalog rather than parsing removed import aliases/array syntax. Retain duplicate-delivery-path, name-mismatch, missing-content, and missing-remote-skill checks.
- Add completeness tests proving every seed candidate appears exactly once in the embedded catalog and that adding a new template no longer requires editing `src/be/seed-skills/index.ts`.

#### 3. Move the Composio remote-install reference

**Files**: `apps/ui/src/lib/integrations-catalog.ts`, `docs-site/content/docs/(documentation)/integrations/composio.mdx`, `scripts/check-skill-sources.ts`

**Changes**:

- Change the recommended skill path from `plugin/skills/composio` to `templates/skills/composio` and update the documentation example.
- Keep the existing remote-path existence check and add a focused assertion that the Composio target is present at its new path.
- Do not reconcile unrelated seeded/remote sibling files in this phase.

#### 4. Remove repository-skill copying without breaking retained baked skills

**Files**: `Dockerfile.worker`, `runbooks/docker-images.md`

**Changes**:

- Change the pinned `skills@1.5.20` installs for `agent-fs`, the still-baked ai-toolbox set, and full-image `qa-use` to copy to all supported agents (the CLI supports `--agent '*'` and `--copy`). Add build-time assertions for the swarm's Claude, Pi, Codex, OpenCode, and universal Agents paths.
- Delete `COPY plugin/skills/` from both the `worker-slim` and `worker-full` leaf blocks.
- Delete both generic `cp -aL /home/worker/.claude/skills/. ...` harness-tree mirror blocks after the explicit installer targeting is proven.
- Keep the duplicated `plugin/commands/` and `plugin/agents/` leaf logic and the Pi/Codex command variants unchanged.
- Update the Docker runbook so it no longer claims that a generic leaf mirror performs fanout.

#### 5. Prove the required seed catalog before removing the fallback

**Files**: `src/be/seed-skills/readiness.ts` (new), `src/be/seed/registry.ts`, `src/http/skills.ts`, `docker-entrypoint.sh`, `src/tests/seed-catalog-readiness-http.test.ts` (new), `src/tests/entrypoint-seed-catalog-readiness.test.ts` (new), `src/tests/fixtures/seed-catalog-readiness/{old-healthy.json,seed-incomplete.json,repository-skills-v1.json,empty-agent-skills.json,malformed-agent-skills.json,partial-agent-skills.json}` (new)

**Changes**:

- Retain the current process's `skillsSeeder` result from `runAllSeeders()` and expose an authenticated `GET /api/seed-catalog/readiness` route. Return 200 with `ready: true` and `capabilities: ["repository-skills-v1", ...]` only after the skill seeder completed with zero failed items and DB verification finds exactly one enabled swarm-scope row for each of the five required names. Return 503 while the seed run is absent, failed, or incomplete. Do not derive this response from `/health` alone.
- Keep the capability additive instead of requiring equality with a whole-catalog content hash: a Phase-1 worker remains compatible with a later Phase-3 API, while an old API has no endpoint/capability and cannot falsely satisfy the gate.
- Before deleting either image fallback, add a marked/extractable `wait_for_seed_catalog` helper near the existing entrypoint skill-sync block for every non-`claude-managed` worker or lead that uses filesystem skills. Poll the authenticated endpoint with short curl connect/request timeouts for a fixed, bounded 30-second compatibility window and require `repository-skills-v1`. An endpoint 404, 200 without the capability, 503 seed-incomplete response, invalid JSON, or timeout exits with stable code 78 and a non-secret fatal line before the runner starts.
- After the capability proof, make the required-five agent-skill fetch/write fail closed rather than using the current `|| true` path. Require a successful `/api/agents/${AGENT_ID}/skills` response containing each required name exactly once with non-empty simple-skill content; reject an empty, malformed, duplicate, or partial response. Stage each required skill and atomically install it into `.claude/skills`, `.pi/agent/skills`, `.codex/skills`, `.opencode/skills`, and `.agents/skills`; any fetch, parse, staging, or filesystem error exits 78 before runner launch. Other non-required legacy/remote skill handling may remain best-effort after this required set is durable, and runner refresh still owns later live reconciliation.
- Keep Phase 2's later `/health` gate separate: if Phase 2 lands first it can wait for generic API liveness, but Phase 1 still requires the catalog capability. If Phase 1 lands first, this local 30-second gate alone prevents a new worker from starting without DB-delivered replacements.
- Document API-first rollout: deploy the new API, wait until `/api/seed-catalog/readiness` reports `repository-skills-v1`, then deploy Phase-1 workers. Roll back workers before rolling the API below this capability. During a mistaken API-first rollback, new workers fail closed/restart rather than silently launching without skills; existing workers keep their last synchronized filesystem copies.
- Test the real extracted helpers against the committed HTTP fixtures: `old-healthy.json` returns 200 from `/health` but 404/no capability from the catalog route; `seed-incomplete.json` returns 503; `repository-skills-v1.json` returns the required capability and complete agent-skill payload; and the empty/malformed/partial fixtures fail after capability success. Assert every incompatible or incomplete case exits 78 within the bounded window without launching the runner, while the complete fixture produces byte-correct files in all five trees and proceeds.

#### 6. Add deterministic migration/inventory gates and update authoring guidance

**Files**: `CLAUDE.md`, `runbooks/skills.md`, `.github/workflows/merge-gate.yml`, `package.json`, `src/tests/seed-skill-catalog.test.ts` (new), `src/tests/fixtures/worker-skill-delivery/repository-owned.json` (new), `scripts/test-worker-skill-delivery.ts` (new), `src/tests/system-default-skills.test.ts`, `src/tests/seed-skills-bundled-files.test.ts`

**Changes**:

- Replace instructions to add static imports/list entries with the generated-catalog workflow.
- Add exact package entrypoints: `test:seed-skill-catalog` runs `bun run test:root -- src/tests/seed-skill-catalog.test.ts src/tests/seed-catalog-readiness-http.test.ts`; `test:seed-catalog-rollout` runs `bun run test:root -- src/tests/entrypoint-seed-catalog-readiness.test.ts`; and `test:worker-skill-delivery:repository` runs `bun scripts/test-worker-skill-delivery.ts --scenario repository-owned`. Add their source/fixture files plus the catalog generator/output to the Seeded Skills and Docker change detectors, and invoke all three commands from their respective Merge Gate jobs.
- Make `src/tests/seed-skill-catalog.test.ts` own the fresh/existing DB proof. Its fixture creates a unique SQLite path, runs `skillsSeeder` once, asserts the exact five names/description/body/scope/default flags and one row per name, runs it again against the same DB, and asserts no duplicates. A second named test changes one seeded body and bundled file before re-running and deterministically asserts the user modification is preserved. `afterAll` removes the DB plus WAL/SHM companions.
- Make `repository-owned.json` the exact expected inventory for all five harness trees. `scripts/test-worker-skill-delivery.ts --scenario repository-owned` must (1) inspect slim/full images before API sync, proving the migrated five are absent while retained baked inventory is present in the expected trees, (2) run the real fail-closed entrypoint catalog/fetch/write helpers against the complete fixture into mounted temporary homes, and (3) compare all five post-sync trees byte-for-byte to the fixture. Repeat the sync and assert an empty filesystem diff; separately run the empty/malformed/partial payloads and assert no runner launch or partially installed required set.
- Extend existing focused seed tests to assert deterministic embedded-vs-disk equality, generated-catalog completeness, and the Composio remote-path move. Keep browser screenshots out of these non-visual gates.

### Success Criteria:

#### Automated Verification:

- [ ] Dependencies install exactly from the lockfile: `bun install --frozen-lockfile`
- [ ] Type checking passes: `bun run tsc:check`
- [ ] Linting passes: `bun run lint`
- [ ] Full root tests pass: `bun run test:root`
- [ ] Worker/API database ownership remains intact: `bash scripts/check-db-boundary.sh`
- [ ] Dependency boundaries pass: `bun run check:dep-graph`
- [ ] Skill invariants and both generated manifests are current: `bun run check:skill-sources && bun run check:seed-skill-catalog && bun run check:seed-skill-files`
- [ ] Fresh/existing DB catalog assertions and focused skill tests pass: `bun run test:seed-skill-catalog && bun run test:root -- src/tests/seed-skills-bundled-files.test.ts src/tests/system-default-skills.test.ts src/tests/skill-fs-writer.test.ts src/tests/skill-sync.test.ts`
- [ ] Old-healthy, seed-incomplete, empty, malformed, partial, and complete rollout fixtures pass against the real shell helpers: `bun run test:seed-catalog-rollout`
- [ ] UI checks required by the Composio catalog change pass: `(cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b)`
- [ ] Package-triggered API artifacts remain current: `bun run docs:openapi && git diff --exit-code -- openapi.json docs-site/content/docs/api-reference`
- [ ] The full Docker matrix builds and tags the exact images consumed below: `docker build -f Dockerfile -t agent-swarm-api:latest . && bun run docker:build:worker:slim && bun run docker:build:worker && docker build -f apps/evals/Dockerfile -t agent-swarm-evals:latest .`
- [ ] Slim/full pre-sync inventory plus repeatable five-tree post-sync delivery match the committed fixture: `bun run test:worker-skill-delivery:repository -- --slim-image agent-swarm-worker:slim --full-image agent-swarm-worker:latest`

#### Automated QA:

- [ ] Execute the committed Docker/filesystem inventory scenario, including slim/full pre-sync assertions, ready-catalog sync, restart, and repeat-sync empty diff: `bun run test:worker-skill-delivery:repository -- --slim-image agent-swarm-worker:slim --full-image agent-swarm-worker:latest`
- [ ] Execute the rollout matrix proving old-healthy, seed-incomplete, empty, malformed, and partial skill APIs fail closed while the complete capability-bearing API writes all five trees and proceeds: `bun run test:seed-catalog-rollout`
- [ ] Execute the HTTP contract and DB-backed readiness assertions directly: `bun run test:root -- src/tests/seed-catalog-readiness-http.test.ts src/tests/seed-skill-catalog.test.ts`

#### Manual Verification:

- [ ] Review the five migrated skill bodies against their deleted `plugin/skills/*/SKILL.md` sources to confirm the transformation changed layout/frontmatter only, not operational guidance.
- [ ] Inspect slim/full Docker history to confirm the generic mirror layers and repository-skill COPY layers are gone while `agent-fs` and `qa-use` stay pinned.
- [ ] Run `qa-use` against Settings → Integrations, capture the required screenshot, and confirm Composio displays and installs from `templates/skills/composio` without a remote 404.

**Implementation Note**: Ship this as one PR and pause after verification. Do not remove the Docker fallback unless the capability endpoint, fail-closed entrypoint gate, old/incomplete API fixtures, and worker-delivery command land in the same PR. Phase 3 assumes this generated-catalog contract, but Phase 1 remains correct with ai-toolbox still baked.

---

## Phase 2: Gate Worker Boot on API Readiness

### Overview

Deliver a bounded, non-secret process-readiness poll at the shared lead/worker entrypoint before any API-dependent setup. The container exits non-zero on timeout instead of continuing with missing config and skills. This phase is independent and may land before or after Phase 1, but `/health` success never bypasses Phase 1's seed-catalog capability proof.

### Changes Required:

#### 1. Add an early bounded `/health` poll

**File**: `docker-entrypoint.sh`

**Changes**:

- Move API-key validation plus `ROLE`/`MCP_URL` resolution before provider-specific API reads, then invoke a marked/extractable `wait_for_api_ready` helper before the first such read.
- Poll `${MCP_URL%/}/health` once per second using `curl` with short connect and request timeouts so a single attempt cannot overrun the overall budget.
- Read `WORKER_API_READY_TIMEOUT_SECONDS` from the worker process environment, default it to 90, require a positive integer, and exit non-zero for invalid values.
- Emit one waiting line, one ready line, and a stable fatal timeout line such as `[entrypoint] FATAL: API readiness timed out after 90s waiting for <url>; exiting.` Never include auth headers or the API key.
- Apply the gate to both worker and lead roles because both execute this entrypoint and both require the control-plane API. Keep optional downstream integration reads best-effort after readiness.

#### 2. Add executable regression tests for the real shell helper

**Files**: `src/tests/entrypoint-api-readiness.test.ts` (new), `src/tests/api-readiness-boot.test.ts` (new), `src/tests/fixtures/entrypoint-api-readiness/{immediate.json,delayed.json,unreachable.json}` (new), `scripts/test-entrypoint-api-readiness.ts` (new), `package.json`, `.github/workflows/merge-gate.yml`

**Changes**:

- Extract the actual helper between stable markers from `docker-entrypoint.sh` and execute it in a temporary Bash process, following the deployed-shell extraction pattern in `src/tests/entrypoint-codex-oauth-seed.test.ts`.
- Cover immediate success, transient failures followed by success, unreachable timeout with exact fatal output/non-zero status, invalid/zero/negative timeout, trailing-slash normalization, bounded curl flags, and absence of secrets from stdout/stderr.
- Add a source-order assertion that the invocation precedes the first provider-specific config request.
- Make `src/tests/api-readiness-boot.test.ts` the repeatable fresh/existing DB gate. It creates a unique temporary SQLite path, launches the real API once with an empty DB and once with the same initialized DB, runs the extracted wait helper against both boots, and asserts waiting → ready → first API-backed request in order. It terminates both child processes and removes the SQLite/WAL/SHM files in `afterAll`.
- Make `scripts/test-entrypoint-api-readiness.ts` the Docker-level scenario runner. It consumes the three committed fixtures, uses valid generated UUIDs, starts the built worker image as both worker and lead, and asserts immediate success, delayed start, and unused-port timeout. For the timeout case, assert exact exit status, maximum wall-clock bound, stable fatal text, no API-backed request before readiness, and no occurrence of the fixture API key in stdout/stderr.
- Add exact package entrypoints: `test:entrypoint-api-readiness` runs `bun run test:root -- src/tests/entrypoint-api-readiness.test.ts src/tests/api-readiness-boot.test.ts`; `test:entrypoint-api-readiness:docker` runs `bun scripts/test-entrypoint-api-readiness.ts`. Invoke them from the root-test and Docker Merge Gate jobs whenever the helper, fixtures, configuration validation, or Docker entrypoint changes.

#### 3. Register and validate the operator setting

**Files**: `apps/ui/src/lib/configuration-catalog.ts`, `src/be/swarm-config-guard.ts`, `src/tests/env-flag.test.ts`

**Changes**:

- Add `WORKER_API_READY_TIMEOUT_SECONDS` to the Harness & tools catalog group as a number with default/placeholder `90`, `restartRequired: true`, and a configuration-doc link (`apps/ui/src/lib/configuration-catalog.ts:268-292`).
- Add it to the positive-integer validators and test accepted/rejected values (`src/be/swarm-config-guard.ts:68-82`, `src/be/swarm-config-guard.ts:155-174`).
- Make the UI description explicit that this bootstrap gate reads the worker container environment; a DB row cannot affect the current boot before the API is reachable.

#### 4. Document the bootstrap semantics and failure mode

**Files**: `docs-site/content/docs/(documentation)/ui/configuration.mdx`, `LOCAL_TESTING.md`

**Changes**:

- Document the 90-second default, positive-integer contract, deployment-env requirement, restart behavior, public `/health` endpoint, and clear failure log.
- Update the entrypoint test guidance so optional external dependencies remain best-effort, while the control-plane API waits for a bounded interval and then terminates the container.

### Success Criteria:

#### Automated Verification:

- [ ] Dependencies install exactly from the lockfile: `bun install --frozen-lockfile`
- [ ] Type checking passes: `bun run tsc:check`
- [ ] Linting passes: `bun run lint`
- [ ] Full root tests pass: `bun run test:root`
- [ ] Worker/API database ownership remains intact: `bash scripts/check-db-boundary.sh`
- [ ] Dependency boundaries pass: `bun run check:dep-graph`
- [ ] Shell-unit, fresh/existing DB boot, and config validation tests pass: `bun run test:entrypoint-api-readiness && bun run test:root -- src/tests/env-flag.test.ts`
- [ ] UI checks pass: `(cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b)`
- [ ] Shell syntax and all Docker images affected by the entrypoint pass, with exact test tags: `bash -n docker-entrypoint.sh && docker build -f Dockerfile -t agent-swarm-api:latest . && bun run docker:build:worker:slim && bun run docker:build:worker && docker build -f apps/evals/Dockerfile -t agent-swarm-evals:latest .`
- [ ] Worker/lead Docker readiness scenarios pass against the committed immediate, delayed, and unreachable fixtures: `bun run test:entrypoint-api-readiness:docker -- --image agent-swarm-worker:latest --roles worker,lead`

#### Automated QA:

- [ ] Run the real-image worker/lead matrix and let the script assert log order, bounded exit, stable fatal output, and secret absence: `bun run test:entrypoint-api-readiness:docker -- --image agent-swarm-worker:latest --roles worker,lead`
- [ ] Run the isolated real-API fresh/existing DB lifecycle tests: `bun run test:root -- src/tests/api-readiness-boot.test.ts`
- [ ] Run the extracted-helper cases for invalid settings, trailing slashes, bounded curl flags, and post-readiness optional integration failures: `bun run test:root -- src/tests/entrypoint-api-readiness.test.ts src/tests/env-flag.test.ts`

#### Manual Verification:

- [ ] Review representative boot logs for concise wording, reasonable retry cadence, and no secret-bearing headers or values.
- [ ] Confirm the docs make the bootstrap-only environment limitation understandable rather than implying a dashboard save can alter an already-waiting container.
- [ ] Run `qa-use` against Settings → Configuration, capture the required screenshot of the Harness & tools timeout row/default/restart badge, and confirm the UI rejects `0` and non-numeric input.

**Implementation Note**: Ship this as one PR. Do not combine it with Docker skill-source removal even if both touch `Dockerfile.worker` indirectly through image verification.

---

## Phase 3: Vendor the Pinned ai-toolbox Skill Set

### Overview

Deliver a reproducibly vendored snapshot of the 18 ai-toolbox skills at `cc-desplega-2.0.0`, including supported auxiliary files and CI drift detection, then remove only the ai-toolbox image-build install. `agent-fs` and `qa-use` remain baked.

### Changes Required:

#### 1. Add a deterministic ai-toolbox sync/check script

**File**: `scripts/sync-ai-toolbox-skills.ts` (new)

**Changes**:

- Pin repository `desplega-ai/ai-toolbox`, tag `cc-desplega-2.0.0`, and resolved commit `678ef856b53d036855cf65eabe835280909be135` in source.
- Declare the exact upstream mapping: 17 names under `cc-plugin/base/skills/` and `wts-expert` under `cc-plugin/wts/skills/wts-expert/`.
- Fetch non-interactively into a temporary directory, verify the tag/commit and exact managed inventory, stage the complete expected output, validate text/file limits, then atomically replace only the 18 managed template trees.
- Parse each upstream `SKILL.md` into deterministic `config.json` plus frontmatter-free `content.md`; set `runAllSeedersCandidate: true` and `systemDefault: true` to preserve unconditional baked visibility.
- Copy auxiliary files under `files/` with their paths preserved. Fail on missing expected files, unexpected source files, duplicate names, invalid frontmatter, or partially generated output.
- Explicitly allowlist and omit the known `hooks:` blocks in `implementing`, `phase-running`, `step-running`, and `v-implementing`: the DB renderer cannot represent them, their referenced plugin-root files are outside the skills-only install, and broadening the schema is outside this migration. Emit the omission in sync output and fail on hook metadata in any other skill or on any changed allowlisted shape.
- Add `--check` mode that builds the expected tree without modifying the repository and fails on missing, changed, or extra managed files.

#### 2. Vendor the exact 18-skill inventory

**Files**: `templates/skills/{ask-user,brainstorming,implementing,improve-agents-md,learning,phase-running,planning,qa,questioning,researching,reviewing,script-builder,step-running,tdd-planning,v-implementing,v-planning,verifying,wts-expert}/`

**Changes**:

- Vendor these exact names: `ask-user`, `brainstorming`, `implementing`, `improve-agents-md`, `learning`, `phase-running`, `planning`, `qa`, `questioning`, `researching`, `reviewing`, `script-builder`, `step-running`, `tdd-planning`, `v-implementing`, `v-planning`, `verifying`, and `wts-expert`.
- Preserve the 14 supported auxiliary files across ten skills: six single `template.md` files (`brainstorming`, `learning`, `planning`, `qa`, `questioning`, `researching`); four `script-builder/templates/*` files; `tdd-planning/template.md`; two `v-planning/templates/*` files; and `wts-expert/COMMANDS.md`.
- Regenerate the seeded bundled-file manifest and generated catalog delivered by Phase 1.
- Apply the explicit allowlisted hook-metadata omission above; vendor the supported skill body and auxiliary files without expanding the DB/rendering contract.

#### 3. Wire sync drift checks into the seeded-skills gate

**Files**: `package.json`, `.github/workflows/merge-gate.yml`, `runbooks/skills.md`, `src/tests/ai-toolbox-seeding.test.ts` (new), `src/tests/fixtures/worker-skill-delivery/ai-toolbox.json` (new), `scripts/test-worker-skill-delivery.ts`, `src/tests/system-default-skills.test.ts`, `src/tests/seed-skills-bundled-files.test.ts`

**Changes**:

- Add exact package entrypoints: `sync:ai-toolbox-skills` runs `bun scripts/sync-ai-toolbox-skills.ts`; `check:ai-toolbox-skills` adds `--check`; `test:ai-toolbox-seeding` runs `bun run test:root -- src/tests/ai-toolbox-seeding.test.ts`; and `test:worker-skill-delivery:ai-toolbox` runs `bun scripts/test-worker-skill-delivery.ts --scenario ai-toolbox`.
- Add the sync script, exact inventory fixture, seed test, and managed template paths to the Seeded Skills/Docker change detectors. Run `--check`, the isolated DB test, and the worker-delivery command in their respective Merge Gate jobs alongside catalog/source and bundled-file checks.
- Document the pinned update procedure and which template directories are generated/vendor-managed.
- Make `ai-toolbox.json` the canonical expected 18-name and ten-complex/14-file inventory, including every relative auxiliary-file path and source digest from the pinned commit.
- Make `src/tests/ai-toolbox-seeding.test.ts` the fresh/existing DB proof. With a unique temporary SQLite path, run `skillsSeeder`, compare rows/files to `ai-toolbox.json`, run again against the same DB and assert no duplicates or mutations, then deliberately edit one body and one bundled file and assert a third run preserves both. Remove the SQLite/WAL/SHM files in `afterAll`.
- Extend `scripts/test-worker-skill-delivery.ts --scenario ai-toolbox` to inspect slim/full images before sync, run the real filesystem refresh into mounted temporary homes, compare all five harness trees to `ai-toolbox.json`, repeat the refresh, and assert an empty filesystem diff. Also assert `agent-fs` remains in all five trees, `qa-use` remains full-only, and build logs contain no ai-toolbox network install.
- Keep the existing focused tests for embedded-vs-disk equality and DB complex flags; drive every expected name/file from the committed fixture so a missing or extra item produces a deterministic diff.

#### 4. Remove only the ai-toolbox build-time install

**File**: `Dockerfile.worker`

**Changes**:

- Delete the `desplega-ai/ai-toolbox@cc-desplega-2.0.0` `npx skills add` invocation and its `wts-expert` image assertion from `worker-base` (`Dockerfile.worker:222-230`).
- Keep the pinned `agent-fs` skill install and CLI coupling, the `@desplega.ai/wts` CLI package, and the full-image-only `qa-use` install.
- Update comments so they describe only the baked skills that remain after Phase 1 and this phase.

### Success Criteria:

#### Automated Verification:

- [ ] Dependencies install exactly from the lockfile: `bun install --frozen-lockfile`
- [ ] Type checking passes: `bun run tsc:check`
- [ ] Linting passes: `bun run lint`
- [ ] Full root tests pass: `bun run test:root`
- [ ] Worker/API database ownership remains intact: `bash scripts/check-db-boundary.sh`
- [ ] Dependency boundaries pass: `bun run check:dep-graph`
- [ ] Vendor, source, catalog, and bundled-file drift checks pass: `bun run check:ai-toolbox-skills && bun run check:skill-sources && bun run check:seed-skill-catalog && bun run check:seed-skill-files`
- [ ] Fresh/existing DB ai-toolbox assertions and focused skill tests pass: `bun run test:ai-toolbox-seeding && bun run test:root -- src/tests/seed-skills-bundled-files.test.ts src/tests/system-default-skills.test.ts src/tests/skill-fs-writer.test.ts src/tests/skill-sync.test.ts`
- [ ] Package-triggered generated/API/UI checks remain clean: `bun run docs:openapi && git diff --exit-code -- openapi.json docs-site/content/docs/api-reference && (cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b)`
- [ ] The full Docker matrix builds and tags the exact images consumed below: `docker build -f Dockerfile -t agent-swarm-api:latest . && bun run docker:build:worker:slim && bun run docker:build:worker && docker build -f apps/evals/Dockerfile -t agent-swarm-evals:latest .`
- [ ] Slim/full pre-sync inventory plus repeatable five-tree ai-toolbox delivery match the exact committed fixture: `bun run test:worker-skill-delivery:ai-toolbox -- --slim-image agent-swarm-worker:slim --full-image agent-swarm-worker:latest`

#### Automated QA:

- [ ] Rebuild from the pinned upstream snapshot and prove every generated artifact is deterministic: `bun run sync:ai-toolbox-skills && bun run build:seed-skill-catalog && bun run build:seed-skill-files && git diff --exit-code`
- [ ] Run the committed slim/full and repeated five-tree delivery scenario, including retained `agent-fs`, full-only `qa-use`, and absence of the ai-toolbox network install: `bun run test:worker-skill-delivery:ai-toolbox -- --slim-image agent-swarm-worker:slim --full-image agent-swarm-worker:latest`
- [ ] Run the deterministic API/file contract tests for representative simple and complex vendored skills: `bun run test:root -- src/tests/skill-files-http.test.ts src/tests/skill-get-file-tool.test.ts src/tests/ai-toolbox-seeding.test.ts`

#### Manual Verification:

- [ ] Review the sync diff against the pinned upstream tag for all 18 skills, with special attention to frontmatter removal and auxiliary-file paths.
- [ ] Inspect Docker build logs/history to confirm only the ai-toolbox install disappeared and the `agent-fs`/`qa-use` pins remain intact.
- [ ] Use the Skills UI to inspect `ask-user`, `planning`, `script-builder`, and `wts-expert`, and capture screenshots confirming their rendered bodies/files match the pinned fixture; keep this visual evidence out of the automated API assertions.

**Implementation Note**: Ship this as one PR after Phase 1's generated-catalog foundation. Do not migrate `agent-fs` or `qa-use` as a follow-on inside this PR.

---

## Open Questions

1. **Bootstrap timeout delivery model**: a global `swarm_config` row cannot control the current pre-API readiness wait, because the worker can fetch that row only after the API becomes ready. Phase 2 treats the catalog entry as discovery/validation for a deployment-provided worker environment variable and documents the limitation. Should a later configuration-system change add an explicit `bootstrapOnly`/worker-env propagation model instead of the server-centric `restartRequired` badge?
2. **Future ai-toolbox hook parity**: Phase 3 explicitly allowlists and reports omission of the four currently non-portable `hooks:` blocks instead of expanding the DB schema. Should a later project add cross-harness hook metadata plus vendor/rewrite the referenced plugin-root scripts, or should these plugin-only hooks remain permanently outside seeded skills?

## Appendix

- **Follow-up plans**: A future plan may define parity/versioning semantics for templates intentionally serving both seeded `content.md` and remote-install `SKILL.md`; that question is not required for this migration.
- **Derail notes**: The research measured skills at well under 0.1% of the worker image. Do not report material image-size or cold-boot improvement from these phases.
- **References**:
  - Research: `thoughts/taras/research/2026-07-31-baked-skills-to-db-seeding.md`
  - Merged foundation: https://github.com/desplega-ai/agent-swarm/pull/1044
  - Skills delivery: `runbooks/skills.md`
  - Docker invariants: `runbooks/docker-images.md`
  - Local verification: `LOCAL_TESTING.md`
