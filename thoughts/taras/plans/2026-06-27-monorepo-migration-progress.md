---
date: 2026-06-27
status: in-progress (autopilot, full migration)
plan-of-record: thoughts/taras/plans/2026-06-26-monorepo-collapsed-first.md
---

# Monorepo Migration — Execution Progress Tracker

Driving the full collapsed-first plan (18 `@swarm/*` packages + 7 apps) as **ONE PR (#833)** —
all phases land as sequential green commits on `chore/monorepo-phase-0-scaffold`. (Taras: "should be
in the same PR".) `main` auto-deploys on merge, so #833 stays unmerged until review; each commit keeps
the full suite green. Update #833's title/body from "Phase 0" → full migration when done.

## Phase status (all commits on `chore/monorepo-phase-0-scaffold` → PR #833)

| Phase | Status |
|---|---|
| 0 — Bun workspaces + Turbo scaffold | ✅ DONE (commit c074abc4) |
| 1 — tsconfig bridge + ts-morph codemod + packages.map.json | ✅ DONE (verified: tsc 0, test 5439, docker, lint, turbo) |
| 2 — Extract L0+L1 leaves | 🔄 DONE (9): types, otel, credentials, prompt-templates, artifacts, core-utils, scripts, e2b-dispatch, ai-pricing (204c11e9). DEFERRED: swarm-templates (touches templates-ui Next app prebuild + folds schema types into @swarm/types — do with app split), api-client (NET-NEW generated from openapi + CI gate — additive, not on critical path) |
| 3 — Extract L2 (ai-llm [+raters hoist&fold], mcp-tool) | ✅ DONE: ai-llm (0391056c, cycle-break #2 — grep be/ empty), mcp-tool (ae35a5b8) |
| 4 — Extract L3 (harness, storage [+test-preload pivot]) | ✅ DONE: harness (eae401d0), **storage (b5c4af0e)** — the keystone. src/be/ GONE. Preload pivot via @swarm/storage/db subpath; barrel text-import fixed; 176 files moved; fresh-DB boot 96 migrations; test 5444. main MERGED in (31acccbc). |
| 5 — Extract L4+L5 (workflows, integrations) | ✅ DONE: workflows (117166c0, L4), integrations (eb138d4c, L5 — one-shot, not slack-first). test 5444/0, boundaries, fresh-DB boot clean |
| 6 — api-server + apps split | 🔄 api-server DONE (bd2d027b, last package). **APPS SPLIT DONE (8f2b2d91): apps/cli + apps/api created, src/ now ONLY tests/.** Both docker images build, openapi clean, test 5444. DEFERRED below. |

## ✅ STRUCTURE ACHIEVED (8f2b2d91, pushed, 29 commits ahead of main):
## `packages/` (16 real + swarm-templates/api-client shims) · `apps/{api,cli}` · `src/` = ONLY `tests/` (co-located per plan).
## Every commit green: tsc 0 · lint 0 · test 5444/0 · all boundaries · openapi byte-identical · BOTH docker images · build:cli · fresh-DB boot.

## REMAINING (deferred — lower-risk / needs coordination):
- **ui/ templates-ui/ evals/ docs-site/ → apps/{ui,templates-ui,evals,docs}**: file moves + workspace/CI/bunfig/.dockerignore updates + the ui modelsdev symlink depth + evals e2b-dispatch import + evals CI working-dir. **⚠️ Vercel risk**: ui/templates-ui Vercel projects' Root Directory expects ./ui, ./templates-ui — moving to apps/ needs Vercel settings coordination with Taras (don't blind-move). docs-site is standalone pnpm/Vercel.
- **createServer side-effect extraction**: initDb/seedPricing/startPricingRefreshLoop OUT of packages/api-server/src/server.ts createServer() INTO apps/api/src/http.ts bootstrap; keep createServer pure. (Behavior unchanged today since http.ts→createServer still inits.)
- **Publish-identity move**: root package.json stays @desplega.ai/agent-swarm; plan moves it to apps/cli. Deferred (root-as-published works).
- **dependency-cruiser .cjs DAG** (replaces grep boundary checks); **swarm-templates** (templates-ui prebuild→workspace dep + fold schema types into @swarm/types); **api-client** (generate from openapi + CI gate).
- Stale doc hint strings: `bun run src/cli.tsx claude-managed-setup` in packages/{api-server,harness}; docs-site x402-payments.mdx `bun src/x402/cli.ts`.

## Invariants to keep green after EVERY step
`bun run tsc:check` · `bun run lint` · `bun test` (5439) · `check-db-boundary.sh` · `check-api-key-boundary.sh` ·
`check-audit-columns.sh` · `check-sdk-tool-registration.ts` · `bunx turbo run build --dry-run` ·
`cd ui && bun run build` · `cd templates-ui && bun run build` · `cd evals && bun test` ·
`docker build -f Dockerfile .` + `-f Dockerfile.worker .` · ui mounts in browser (react/react-dom override).

## Phase-0 carryover gotchas (see memory `project_monorepo_restructure`)
- `bunfig.toml` linker="hoisted"; root `overrides` react/react-dom→19.2.3; ui biome pinned 2.4.5.
- `.dockerignore` `!evals/package.json`; Dockerfiles copy member manifests + bunfig before frozen install.
- Vercel deploy detection risk (ui/templates-ui lost per-app pnpm locks) — verify before merging Phase 0.

## Key constraints
- Tests STAY co-located in `src/tests` during migration (import packages by name via the bridge). Physical split is a follow-up.
- Codemod + file move land in the SAME commit so each step is independently green.
- Deferred raters #2 hoist lives on local branch `wip/raters-hoist-deferred`; applied in Phase 3 (hoist + fold `be/memory/raters/types.ts` into ai-llm).
- `createServer()` db/pricing side-effects → `apps/api` bootstrap (Phase 6, the one genuine refactor).
- `plugin/` stays at repo root (out of split).

## Phase 1 artifacts (DONE, on branch)
- `packages.map.json` — path→package map (file-level for split dirs: tools/, providers/, be/, heartbeat/, utils/). 490 src files owned, 48 left for apps/cli+api.
- `packages/<pkg>/` (18) — shim `package.json` + barrel `index.ts` re-exporting live `src/` (additive; nothing imports them yet). Generated by `scripts/generate-barrels.ts` (regenerable from the map).
- `scripts/codemod-imports.ts` (ts-morph) — `--dry-run`(default)/`--apply`/`--package <name>`. Rewrites `@/`+relative → bare `@swarm/<pkg>`; preserves `import type`; never touches dynamic `import()`; longest-match resolver; idempotent.
- root `package.json` workspaces += `packages/*`; `ts-morph@28` devDep; tsconfig `@swarm/*` paths.
- Dockerfiles: `COPY packages ./packages` before frozen install (new workspace members).

## ⚠️ Codemod design limitation to resolve during extraction (NOT yet a problem)
Barrels resolve `export *` name COLLISIONS with `export * as <Ns>`. The codemod rewrites to BARE
`@swarm/<pkg>`, so a consumer importing a *colliding* (namespaced) symbol will fail to resolve after
rewrite. Collisions per pkg: storage 27, api-server 35, integrations 12, workflows 3, scripts 2, ai-llm 2,
core-utils/otel/artifacts/harness 1 each (types, e2b-dispatch, prompt-templates, ai-pricing, credentials,
swarm-templates = 0). Plan: extract per-package, `--apply` the codemod, run tsc, and for the few
collision-induced errors either rewrite those specific specifiers to a subpath (`@swarm/<pkg>/<subpath>`,
needs a subpath export/path) or un-namespace by curating the barrel. Validate the codemod on `@swarm/types`
(0 collisions) FIRST.

## ⚠️ Barrel gotcha learned in Phase 2 (scripts) — applies to any pkg with a subprocess entrypoint
Phase-1 `generate-barrels` does `export *` from EVERY mapped module. If a module has **throwing
top-level side effects** (e.g. a sandbox-subprocess ENTRYPOINT that calls `requiredEnv(...)` at
module scope), re-exporting it via the barrel makes EVERY consumer crash *at import* the moment the
codemod points them at the bare `@swarm/<pkg>`. In scripts, `eval-harness.ts` + `extract-args-schema.ts`
(both zero-export, spawned by path) had to be DROPPED from the barrel. Also: generator/CI scripts that
only need a leaf symbol must import that module **directly** (not via the barrel) for the same eager-load
reason — `bundle-script-types.ts` + `check-sdk-tool-registration.ts` import `sdk-allowlist` directly.
Watch for this in harness/integrations/api-server (likely have similar by-path entrypoints).

## Map decisions flagged for re-check at extraction
- `src/utils/crypto.ts` doesn't exist → `src/be/crypto/` (secrets cipher, DB-bound) assigned to storage.
- `harness-provider.ts` / `provider-metadata.ts` live under `src/utils/` (not `src/providers/`) → credentials.
- core-utils picked up budget-backoff/pretty-print/request-auth-context/skill-fs-writer/skills-refresh; harness picked up aws-error-classifier/mcp-server-fetcher; storage picked up src/memory/automatic-task-gate.ts — all by importer analysis (in map `notes`).

## STATE AT CHECKPOINT (2026-06-27): 11 packages extracted + bridge, all on #833, pushed
Done: bridge(Phase1) + types, otel, credentials, prompt-templates, artifacts, core-utils, scripts,
e2b-dispatch, ai-pricing (Phase2) + ai-llm, mcp-tool (Phase3). Every commit green: tsc 0 / lint 0 /
test 5439 / boundaries / both docker images. Remaining: harness, storage (Phase4), workflows,
integrations (Phase5), api-server + apps split + cutover (Phase6), swarm-templates + api-client (deferred).

## PROVEN per-package recipe (use for every remaining package)
1. `bun scripts/codemod-imports.ts --apply --package @swarm/<pkg>`  (BEFORE moving — resolves vs live src/)
2. `bun run lint:fix`  (biome re-sorts imports — REQUIRED or lint fails)
3. `bun tsc --noEmit` → 0  (consumers resolve via barrel→old src location)
4. `git mv` source files src/… → packages/<pkg>/src/…  (preserve subdir structure; per packages.map.json)
5. Repoint barrel packages/<pkg>/index.ts → ./src/… (keep any `export * as <Ns>` namespacing)
6. rmdir emptied src/ dirs
7. `bun tsc --noEmit` → 0. Fix: (a) COLLISIONS — a consumer importing a namespaced symbol fails;
   expose it flat in the barrel (`export { X } from "./src/…"`) or repoint the one consumer. (b)
   external importers in evals/ (codemod doesn't scope evals/) — repoint by hand to @swarm/<pkg>.
   (c) barrel must NOT `export *` a module with THROWING top-level side effects (subprocess
   entrypoints) — drop it from the barrel (scripts lesson).
8. FULL gate: tsc 0 · lint 0 · `bun test`=5439/0 · db/api-key/audit/sdk checks · (docker periodically).
9. Commit green: `refactor(monorepo): Phase N — extract @swarm/<pkg> (L#)`. Push periodically.

## ⚠️ Phase 4 = harness + storage — HIGHEST RISK (do with FRESH context, careful)
- **harness** (L3): the dynamic-import provider factory `src/providers/index.ts` (load-bearing PR#452 — codemod
  already preserves `import()`, only rewrites the string) + 6 adapters + contract files + `src/claude.ts` +
  `src/commands/provider-credentials.ts`. Map has the file list. Providers use `.js` imports heavily — codemod
  now handles `.js`→.ts. Add a smoke test that harness's module graph excludes the 6 adapter SDKs until
  `createProviderAdapter()` runs.
- **storage** (L3, LARGEST, the DB owner): move db.ts, migrations/ (+.sql), db-queries/, events/users/audit,
  task-lifecycle-events.ts, DB memory stores + chunking/embedding/reranker (folds memory-core), seed-pricing.ts
  WRITER (the pure builder already moved to ai-pricing Phase2 — split seed-pricing.ts now), pricing-refresh.ts,
  be/scripts/, be/seed-skills, src/pages/ + src/metrics/ (folds swarm-pages), src/utils/page-session.ts.
  - **THE TEST-PRELOAD PIVOT (plan §10 risk #2 — the dangerous bit):** `src/tests/preload.ts` (+ bunfig.toml
    preload) import `initDb/getDb/closeDb` from `../be/db`. The package index MUST export
    `initDb/getDb/closeDb/serialize`. Repoint the preload to `@swarm/storage` and SMOKE-TEST the preload in
    ISOLATION (`bun --preload ./src/tests/preload.ts -e "1"`) BEFORE running the 218-DB-importing-file suite —
    a missing export breaks the ENTIRE suite at preload.
  - Verify `grep -rn 'github|slack|linear|jira' packages/storage/src` is empty (be→github already inverted PR#822).
  - Fresh-DB migration smoke: `rm -f agent-swarm-db.sqlite && bun run start:http`.
  - DB-bound: barrels here have 27 collisions — expect collision fixes. `bunfig.toml` preload path moves with it.

## ⚠️ STORAGE: attempted, reverted clean. The move/codemod/preload/migrations/boundaries ALL worked
## (677 specifiers/422 files rewritten, ~130 files moved, preload smoke passed, tsc 0, lint 0, boundaries OK,
## inversion held). Blocked on 2 things — DECISIONS MADE, do these FIRST next attempt:
## 1. **Barrel text-import poisoning (production bug, must fix).** The storage bridge barrel `export *`s the
##    `be/seed-scripts/catalog/*.ts` files, but `seed-scripts/index.ts` text-imports them `with {type:"text"}`.
##    Eager ESM barrel eval loads the catalog MODULES before seed-scripts/index, so the text-import gets the
##    module (a function) not source text → `SEED_SCRIPTS[*].source` corrupted (15/18). Same class as the 4
##    `.inline.ts` files already dropped from the scripts barrel. **FIX: exclude every text-imported source
##    file (catalog/*, *.inline.ts) from the storage barrel** (only consumer is seed-scripts.test.ts, which
##    should import them directly/relatively). Also patch `scripts/generate-barrels.ts` to skip files that are
##    text-imported anywhere (detect `with { type: "text" }`) so future bridge barrels don't reintroduce it.
## 2. **Codemod gaps + test-reference repoints — AUTHORIZED.** The "never edit tests" rule = never change what a
##    test ASSERTS; mechanically repointing a MOVED import specifier in a test file IS allowed (it's not a logic
##    change). The codemod doesn't yet rewrite: `require("..")`, `mock.module("..")`, a default-import of a
##    barrel named-default, a namespaced-collision import, or `new URL("../..", import.meta.url)` / `join(import.meta.dir,"..")`
##    PATH STRINGS (depth changes on move). EITHER extend the codemod for `require()`+`mock.module()` (mechanical)
##    OR hand-repoint the ~4 affected files (gitlab-vcs-db, mcp-oauth-queries require(); memory-http-recall-gating
##    mock.module(); seed-scripts.test.ts default/namespaced/join-path; extract-schema.ts new URL depth). With #1+#2
##    the agent confirmed storage reaches green (it got to 5427/1fail, the 1 fail was purely the #1 poisoning).
## 3. preload.ts: import initDb/getDb/closeDb/serialize — the agent found the storage barrel eager-loads the whole
##    graph, so preload should import db.ts DIRECTLY (relative or a dedicated lightweight `@swarm/storage/db` subpath),
##    not the fat barrel. bunfig preload path itself stays (tests stay co-located).

## ✅ Phase 5 DONE — lessons for Phase 6 (api-server, the next big one)
- **Codemod scopes src/+scripts/+deploy/ ONLY — NOT packages/.** Consumers that already live in an
  extracted package (e.g. storage's dynamic `import("@/workflows/event-bus")`) are NOT rewritten by
  `--package`; hand-repoint them. Grep `packages/**` for `@/<newpkg>` + relative cross-pkg imports BEFORE moving.
- **Side-effect imports (`import "x"` with no bindings) are NOT caught by tsc** but break at runtime. Grep
  `^import ['\"]` in the moved sources for depth-broken ones (workflows `worker-follow-up.ts` → `../tools/templates`
  broke; fixed to depth-independent `@/tools/templates`). The `from`-based greps miss these.
- **Intra-package `@/` absolute imports break on move** (workflows scheduler.ts `@/tasks/*`); convert to relative.
  Cross-dir relative imports that move together (jira→`../oauth`) stay valid.
- **Barrel must drop run-by-path CLI entrypoints** (zero-export shebang `x402/cli.ts` ran its CLI on eager barrel
  eval → printed help at boot). Same class as the dropped scripts subprocess entrypoints. Boot-smoke catches these.
- **Collisions:** flat-re-export symbols UNIQUE to a namespaced module (workflows getExecutorRegistry/initWorkflows/
  createStandaloneScheduleTask; integrations keepalive start/stop + wrapper _getPendingState/_clearPendingStates).
  GENUINE name collisions (gitlab vs github IssueEvent/handleIssue) → a subpath: physical `gitlab.ts` re-export +
  tsconfig path, repoint the few consumers.
- **NO package.json `exports` field for integrations** (unlike storage's `./db`): tests deep-import
  `@swarm/integrations/src/<dir>/templates?t=<n>` for side-effect re-registration; an exports map encapsulates and
  breaks them. Colliding `_test` name (keepalive+jira) is omitted from the flat barrel → deep-import the module directly.
- workflows→integrations (notify/HITL slack) + storage→workflows (event-bus) inversions stay DYNAMIC via bare
  `@swarm/*` specifiers. be→github task-lifecycle: github subscribes via `onTaskStarted` from `@swarm/storage` (consumer).
- Phase-5 docs follow-up deferred to Phase 6 cutover: docs-site x402-payments.mdx still says `bun src/x402/cli.ts`.

## Phase 5 (workflows [engine+swarm+scheduler+tasks], integrations) — DONE, see above
## Phase 6 (api-server + apps split + createServer side-effect→apps/api bootstrap + CI/Docker/openapi cutover +
##   .dependency-cruiser.cjs DAG + rewrite check-db-boundary WORKER_PATHS to package dirs + api-client generate)
See plan-of-record §8 Phase 4/5/6 for the exact file lists + verification.

## DEFERRED (do alongside Phase 6 app split): swarm-templates (templates-ui Next prebuild→workspace dep +
## fold TemplateConfig/TemplateResponse into @swarm/types), api-client (NET-NEW: generate from openapi + CI gate).
