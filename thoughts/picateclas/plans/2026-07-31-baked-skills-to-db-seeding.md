# Baked Skills to Database Seeding Implementation Plan

## Overview

Move the remaining repository-owned and pinned ai-toolbox skills from worker-image installation into the existing database seeder, while making worker startup fail clearly when the API never becomes ready. The work is split into three independently shippable PRs; the collision and multi-file foundation described as Phase 0 in the research is already shipped in PR #1044 and is not planned again here.

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
- The canonical public readiness endpoint is `GET /health`, not `/api/health` (`src/http/core.ts:289-305`). The server starts listening only after startup configuration and built-in seeders finish, making this endpoint a suitable seeding-readiness signal.
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
- Worker and lead containers poll `${MCP_BASE_URL}/health` before any API-dependent setup, stop waiting after a validated timeout, and exit non-zero with a stable non-secret fatal message when the API remains unavailable.
- The pinned 18-skill ai-toolbox snapshot lives under `templates/skills/`, including its 14 supported auxiliary files, with a non-interactive sync/check script and CI drift gate.
- Worker images no longer run the ai-toolbox `npx skills add` block or copy repository skills, while `agent-fs`, `qa-use`, `plugin/commands/`, and `plugin/agents/` retain their intended baked delivery.
- Each of the three phases can merge alone without relying on an unmerged later phase.

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

- Land three PRs corresponding exactly to Phases 1-3 below. Phase 2 is independent and may land before or after either skill migration.
- Make Phase 1 the catalog-discovery foundation. Use a generated, checked catalog artifact so the compiled binary embeds discovered sources without a runtime templates dependency.
- Preserve delivery parity before deleting image fanout: the pinned installer must copy retained baked skills to all supported agent targets, with assertions on the five paths the swarm actually uses.
- Treat vendoring as a reproducible transformation: explicit upstream paths and pin, staged writes, strict validation, deterministic output, and a `--check` mode.
- Keep verification evidence inside each PR. Fresh-DB and existing-DB runs must use isolated/local data only; never run destructive DB commands against a live deployment.

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

Deliver a compiled, generated seed catalog containing the five formerly baked repository skills, remove their image copies and generic leaf-stage mirrors, and preserve all-harness delivery of the intentionally retained baked dependencies. This phase is one independently shippable PR.

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

- Add a Bun generator that scans `templates/skills/*/config.json`, validates directory/name/body rules, filters `runAllSeedersCandidate: true`, reads `content.md`, sorts by skill name, and writes a deterministic embedded catalog containing config plus body text.
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

#### 5. Update skill authoring and CI guidance

**Files**: `CLAUDE.md`, `runbooks/skills.md`, `.github/workflows/merge-gate.yml`, `src/tests/system-default-skills.test.ts`, `src/tests/seed-skills-bundled-files.test.ts`

**Changes**:

- Replace instructions to add static imports/list entries with the generated-catalog workflow.
- Add the catalog generator/checker and generated output to the Seeded Skills change detector and job.
- Extend seed tests to assert the exact five migrated names, their descriptions/content, system-default behavior, deterministic embedded-vs-disk equality, idempotent re-seeding, and no duplicate rows on an existing DB.

### Success Criteria:

#### Automated Verification:

- [ ] Dependencies install exactly from the lockfile: `bun install --frozen-lockfile`
- [ ] Type checking passes: `bun run tsc:check`
- [ ] Linting passes: `bun run lint`
- [ ] Full root tests pass: `bun run test:root`
- [ ] Worker/API database ownership remains intact: `bash scripts/check-db-boundary.sh`
- [ ] Dependency boundaries pass: `bun run check:dep-graph`
- [ ] Skill invariants and both generated manifests are current: `bun run check:skill-sources && bun run check:seed-skill-catalog && bun run check:seed-skill-files`
- [ ] Focused skill tests pass: `bun run test:root -- src/tests/seed-skills-bundled-files.test.ts src/tests/system-default-skills.test.ts src/tests/skill-fs-writer.test.ts src/tests/skill-sync.test.ts`
- [ ] UI checks required by the Composio catalog change pass: `(cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b)`
- [ ] Package-triggered API artifacts remain current: `bun run docs:openapi && git diff --exit-code -- openapi.json docs-site/content/docs/api-reference`
- [ ] The full Docker matrix builds: `docker build -f Dockerfile . && docker build -f Dockerfile.worker --target worker-slim . && docker build -f Dockerfile.worker . && docker build -f apps/evals/Dockerfile .`
- [ ] Fresh-DB seeding succeeds on an isolated local checkout: `rm agent-swarm-db.sqlite && bun run start:http`; wait for `curl -sf http://localhost:3013/health`, then assert the five skills exist once at swarm scope with their expected content. Remove local `-wal`/`-shm` companions before the run if present.
- [ ] Existing-DB seeding succeeds: stop and restart `bun run start:http` against that same local DB, assert the seeder settles without duplicates or failed items, and verify a deliberately user-modified seeded skill remains preserved.

#### Automated QA:

- [ ] Boot slim and full worker images before the API sync and verify `agent-fs` exists in all five harness trees, ai-toolbox remains present in all five for this intermediate phase, and `qa-use` exists in all five only in the full image.
- [ ] With a fresh API/DB and valid UUID agent ID, boot a worker and verify all five migrated skills appear in `.claude/skills`, `.pi/agent/skills`, `.codex/skills`, `.opencode/skills`, and `.agents/skills` after runner refresh; restart the worker and verify they remain stable.
- [ ] Verify the image contains no `plugin/skills`-sourced copy of the five migrated skills before API synchronization.
- [ ] Run a `qa-use` session against Settings/Integrations and capture a screenshot showing Composio's recommended skill resolves to `templates/skills/composio`; exercise the install action and confirm no remote 404.

#### Manual Verification:

- [ ] Review the five migrated skill bodies against their deleted `plugin/skills/*/SKILL.md` sources to confirm the transformation changed layout/frontmatter only, not operational guidance.
- [ ] Inspect slim/full Docker history to confirm the generic mirror layers and repository-skill COPY layers are gone while `agent-fs` and `qa-use` stay pinned.

**Implementation Note**: Ship this as one PR and pause after verification. Phase 3 assumes this generated-catalog contract but Phase 1 must remain correct with ai-toolbox still baked.

---

## Phase 2: Gate Worker Boot on API Readiness

### Overview

Deliver a bounded, non-secret readiness poll at the shared lead/worker entrypoint before any API-dependent setup. The container exits non-zero on timeout instead of continuing with missing config and skills. This phase is independent and may land in any order.

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

**File**: `src/tests/entrypoint-api-readiness.test.ts` (new)

**Changes**:

- Extract the actual helper between stable markers from `docker-entrypoint.sh` and execute it in a temporary Bash process, following the deployed-shell extraction pattern in `src/tests/entrypoint-codex-oauth-seed.test.ts`.
- Cover immediate success, transient failures followed by success, unreachable timeout with exact fatal output/non-zero status, invalid/zero/negative timeout, trailing-slash normalization, bounded curl flags, and absence of secrets from stdout/stderr.
- Add a source-order assertion that the invocation precedes the first provider-specific config request.

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
- [ ] Focused readiness/config tests pass: `bun run test:root -- src/tests/entrypoint-api-readiness.test.ts src/tests/env-flag.test.ts`
- [ ] UI checks pass: `(cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b)`
- [ ] Shell syntax and all Docker images affected by the entrypoint pass: `bash -n docker-entrypoint.sh && docker build -f Dockerfile . && docker build -f Dockerfile.worker --target worker-slim . && docker build -f Dockerfile.worker . && docker build -f apps/evals/Dockerfile .`
- [ ] Fresh-DB readiness succeeds: start a worker against a stopped local API, then run `rm agent-swarm-db.sqlite && bun run start:http` in an isolated local checkout; assert the worker waits until `/health` is live and then proceeds through config/skill setup. Remove local `-wal`/`-shm` companions before the run if present.
- [ ] Existing-DB readiness succeeds: restart `bun run start:http` against the same local DB while another worker waits; assert the same ready transition and no fresh-only seeding assumption.

#### Automated QA:

- [ ] Run the delayed-start Docker scenario for both worker and lead: logs show waiting → ready → API-backed setup in order, and neither process performs API config/skill fetches before readiness.
- [ ] Boot both roles against an unused port with `WORKER_API_READY_TIMEOUT_SECONDS=2`; each exits non-zero within the bounded interval, emits the stable fatal line, and does not leak the API key.
- [ ] Run `qa-use` against Settings → Configuration and capture the Harness & tools timeout row, default, and restart badge; verify `0` and non-numeric values are rejected by the API/UI.
- [ ] Confirm a post-readiness optional integration failure still logs a warning and does not terminate the worker.

#### Manual Verification:

- [ ] Review representative boot logs for concise wording, reasonable retry cadence, and no secret-bearing headers or values.
- [ ] Confirm the docs make the bootstrap-only environment limitation understandable rather than implying a dashboard save can alter an already-waiting container.

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

**Files**: `package.json`, `.github/workflows/merge-gate.yml`, `runbooks/skills.md`, `src/tests/system-default-skills.test.ts`, `src/tests/seed-skills-bundled-files.test.ts`

**Changes**:

- Add `sync:ai-toolbox-skills` and `check:ai-toolbox-skills` package commands.
- Add the sync script to the Seeded Skills change detector and run its `--check` path in that job alongside catalog/source and bundled-file checks.
- Document the pinned update procedure and which template directories are generated/vendor-managed.
- Assert the exact 18-name catalog inventory, exact ten-complex/14-file mapping, embedded-vs-disk equality, DB complex flags, idempotent fresh/existing seeding, user-edit preservation, and repeated five-tree filesystem reconciliation.

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
- [ ] Focused skill tests pass: `bun run test:root -- src/tests/seed-skills-bundled-files.test.ts src/tests/system-default-skills.test.ts src/tests/skill-fs-writer.test.ts src/tests/skill-sync.test.ts`
- [ ] Package-triggered generated/API/UI checks remain clean: `bun run docs:openapi && git diff --exit-code -- openapi.json docs-site/content/docs/api-reference && (cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b)`
- [ ] The full Docker matrix builds: `docker build -f Dockerfile . && docker build -f Dockerfile.worker --target worker-slim . && docker build -f Dockerfile.worker . && docker build -f apps/evals/Dockerfile .`
- [ ] Fresh-DB seeding succeeds on an isolated local checkout: `rm agent-swarm-db.sqlite && bun run start:http`; wait for `/health`, then assert all 18 rows plus the exact 14 bundled files are present. Remove local `-wal`/`-shm` companions before the run if present.
- [ ] Existing-DB seeding succeeds: restart against the same local DB, assert a no-op/duplicate-free seed, and verify a deliberately edited vendored skill/body or bundled file is preserved by seed-state drift handling.

#### Automated QA:

- [ ] Run `bun run sync:ai-toolbox-skills` followed by all generated-file commands and `git diff --exit-code` to prove a sync from the pinned tag is deterministic.
- [ ] Boot a fresh slim worker against the seeded API and verify all 18 skills plus all 14 auxiliary files exist in all five harness trees and survive at least two runner refresh passes.
- [ ] Boot a fresh full worker and verify the same DB-delivered ai-toolbox set, retained all-harness `agent-fs`, and retained full-only `qa-use`; confirm no ai-toolbox network install runs during the image build.
- [ ] Exercise representative simple and complex skills (`ask-user`, `planning`, `script-builder`, `wts-expert`) through the skills API/UI and compare their rendered bodies/files with the pinned upstream snapshot.

#### Manual Verification:

- [ ] Review the sync diff against the pinned upstream tag for all 18 skills, with special attention to frontmatter removal and auxiliary-file paths.
- [ ] Inspect Docker build logs/history to confirm only the ai-toolbox install disappeared and the `agent-fs`/`qa-use` pins remain intact.

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
