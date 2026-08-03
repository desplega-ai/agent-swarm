---
date: 2026-08-03T16:15:00Z
topic: "Baked worker skills → DB skill-seeding migration"
status: in-progress
autonomy: critical
git_commit: 9fd30265
branch: skills-db-seeding
research: thoughts/taras/research/2026-07-31-baked-skills-to-db-seeding.md
---

# Baked Worker Skills → DB Skill-Seeding Implementation Plan

## Overview

Finish the baked-skills→DB migration: single-source the `content.md`/`SKILL.md` twins in `templates/skills/`, migrate the 5 remaining `plugin/skills/` into the seeder, and vendor the ai-toolbox skill set (24 skills from upstream `main`) into `templates/skills/` with a pinned sync script — dropping the corresponding image-bake lines so each skill has exactly one delivery path.

- **Motivation**: Two delivery paths were silently corrupting skills in production (fixed for the 3 collisions by PR #1044, but the same trap re-arms the moment a seeded name collides with an npx-installed one — with **zero CI signal**). Consolidating buys live-updatability (no image rebuild), reproducible builds, and kills the SKILL.md-twin drift trap.
- **Related**: `thoughts/taras/research/2026-07-31-baked-skills-to-db-seeding.md`

### Scope change vs the research doc

The research doc's Phase 0 (live collision bug) shipped as **PR #1044** and its Phase 2 (worker API-readiness gate) shipped as **PR #1060**. Its "replace `BUILT_IN_SKILL_SOURCES` with directory discovery" idea is dead: the API runs from a `bun build --compile` binary, so static text-imports are mandatory (`src/be/seed-skills/index.ts:107-112`); `scripts/check-skill-sources.ts` (CI) makes the static list safe instead.

### Decisions (Taras, 2026-08-03)

1. All migrated/vendored skills get `systemDefault: true` (parity with today's unconditional bake; edit-lock keeps rows pristine so seeder updates keep flowing).
2. Vendor ai-toolbox from **latest `main`** (not the stale `cc-desplega-2.0.0` tag) — Taras updated content and added new base skills. Pin via a **manifest-recorded commit SHA**.
3. Vendored set: **all base skills except `feedback`** (23) + `wts-expert` = **24 skills**.
4. Composio integrations-catalog entry keeps remote-install: `templatePath` moves to `templates/skills/composio` with a sibling `SKILL.md` — which must be **generated**, not hand-maintained (see decision 6).
5. Sync script rewrites repo-absolute template references (`cc-plugin/base/skills/<name>/…`) to skill-relative paths (they're already broken in today's image).
6. The `content.md` vs `SKILL.md` twin duplication in `templates/skills/` gets cleaned up in this plan: `SKILL.md` becomes a **generated artifact** of `config.json` + `content.md` wherever both exist, with a CI freshness check.

## Current State Analysis

### Seeding machinery (post-PR #1044) — all built, nothing structural missing

- `BUILT_IN_SKILL_SOURCES` (`src/be/seed-skills/index.ts:116-127`): 10 seeded skills, each wired via two static `with { type: "text" }` imports (`index.ts:11-62`). Consumed config fields are only `name`, `description`, `runAllSeedersCandidate?`, `systemDefault?` (`index.ts:76-81`).
- `buildSkillContent` (`index.ts:129-131`) generates SKILL.md as `---\nname\ndescription\n---\n\n<body>` — `content.md` must carry **no frontmatter**; no other frontmatter keys (e.g. `hooks:`) are representable. `description` is interpolated raw into YAML.
- Multi-file skills: `templates/skills/<name>/files/**` → `bun run build:seed-skill-files` → `src/be/seed-skills/bundled-files.generated.json` (`scripts/build-seed-skill-files.ts`, text-only via `.text()`, nested dirs OK, keys sorted/deterministic). `skillsSeeder.apply()` writes row + `skill_files` atomically in one transaction (`index.ts:311-342`); `isComplex = files.length > 0`.
- Hash (`skillSeedHash`, `index.ts:161-165`): file-less skills MUST keep hashing byte-identically to the pre-files scheme — **do not touch this function**.
- Delivery (`src/be/db.ts:11834-11866`): UNION of installed rows + broadcast branch `WHERE systemDefault = 1 OR scope = 'swarm'` — every seeded skill reaches every agent with no `agent_skills` row; new agents also get concrete rows for `systemDefault` skills (`db.ts:794`, `11823-11825`). Per-agent toggle-off cannot suppress a broadcast skill (test: `src/tests/system-default-skills.test.ts:172-189`) — the only off switch is global `isEnabled = 0`.
- `systemDefault` lock: content/file mutations and delete return 403 on the HTTP API (`src/http/skills.ts:566,615,643,711-745,785`); `isEnabled` toggle stays allowed. The seeder bypasses via direct `updateSkill`.
- Worker refresh: entrypoint boot sync writes **simple skills only** to `.claude`/`.pi`/`.codex` (`docker-entrypoint.sh:769-784`); the authoritative write (all 5 trees, bundled files, `.swarm-managed` marker) is the runner's `refreshSkillsIfChanged` at runner boot (`src/commands/runner.ts:5083-5106`) and per-task (`:5746-5760`) → `writeSkillsToFilesystem` (`src/utils/skill-fs-writer.ts:121-137`). Signature probe short-circuits unchanged polls (`src/utils/skills-refresh.ts:49-66`); a failed list fetch never wipes on-disk skills (`:102-107`).
- Seeder runs at API boot only (`src/http/index.ts:548-549`); propagation of a `templates/skills` edit = API rebuild/restart + worker's next task poll. No worker restart or image rebuild.

### CI guardrails (Seeded Skills Check job, `merge-gate.yml:491-517`, path filter `SEED_SKILLS` at `:98`)

`scripts/check-skill-sources.ts` enforces: (1) **duplicate-delivery-path** — no name in both `templates/skills/` and `plugin/skills/` (`:83-92`); (2) config `name` == dir name; (3) seeded dirs need `content.md`; (4) **not-wired** — seeded templates need both imports AND a `BUILT_IN_SKILL_SOURCES` entry; (5) **missing-remote-skill** — every catalog `templatePath` needs a real `SKILL.md`.

**Gap**: rule 1 only sees `plugin/skills/`. Names installed via `npx skills add` in `Dockerfile.worker` (agent-fs, qa-use, the 18 ai-toolbox skills) are invisible — seeding one of those names re-creates the exact PR-#1044 truncation bug with no CI failure.

### The 5 remaining baked skills (`plugin/skills/`)

`composio` (8,588 B), `composio-gmail` (4,131 B), `composio-google-calendar` (4,264 B), `composio-google-docs` (3,650 B), `download-task-attachment` (3,279 B). Each a single `SKILL.md`, frontmatter = `name` + `description` only, no bundled files/binaries/executables, no per-harness variants. Cross-references are prose-only `[[wiki-links]]`. env/CLI couplings (`agent-swarm` binary, `$MCP_BASE_URL` etc.) are runtime-injected and independent of skill delivery — nothing blocks seeding.

Delivery today: `COPY plugin/skills/` in BOTH leaf blocks (`Dockerfile.worker:392` slim, `:610` full) + the `cp -aL` mirror (`:416-422`, `:634-640`) into `.pi`/`.codex`/`.opencode`/`.agents`. **The mirror must stay** — it also fans out the npx-installed agent-fs (base) and qa-use (full-base).

External references: `apps/ui/src/lib/integrations-catalog.ts:690` (`templatePath: "plugin/skills/composio"`); `docs-site/content/docs/(documentation)/integrations/composio.mdx:133`. The other 4 names have zero references outside `plugin/skills/`.

### ai-toolbox (upstream `~/Documents/code/ai-toolbox`, remote `desplega-ai/ai-toolbox`)

- Image installs `npx -y skills@${SKILLS_CLI_VERSION} add desplega-ai/ai-toolbox@cc-desplega-2.0.0` with 18 explicit `--skill` flags in worker-base (`Dockerfile.worker:222-227`), asserted by `test -e …/wts-expert/SKILL.md` (`:230`). Same RUN installs agent-fs (`:221`, stays; version-locked to its CLI) and asserts it (`:229`). qa-use is separate in worker-full-base (`:583-586`, stays).
- The `skills` CLI copies each skill directory verbatim; installed content = `SKILL.md` + sibling files. At `main`, base plugin has **24 skills** (tag had 17 + wts-expert). All text, no executables, no binaries at the tag; sync script must re-verify at the pinned SHA.
- 4 skills carry `hooks:` frontmatter referencing `${CLAUDE_PLUGIN_ROOT}/hooks/*.py` — the hook scripts are never installed by the skills CLI, so the hooks are **already inert** in today's image; dropping them loses nothing.
- Multi-file skills at the tag (brainstorming, learning, planning, qa, questioning, researching, tdd-planning +`template.md`; script-builder +4 nested template files; v-planning +2; wts-expert +`COMMANDS.md`) → become `isComplex: true` seeded skills. Set may differ slightly at `main` — sync script discovers dynamically.
- No name collisions with existing `templates/skills/` (21 dirs) or `plugin/skills/`.
- Precedent for sync + drift check: `scripts/refresh-vendored-openapi.ts` + `scripts/check-vendored-openapi.ts` (pinned manifest w/ hashes; network-free `--check`; CI job `merge-gate.yml:581-596`).

### SKILL.md twins (the cleanup Taras asked for)

4 dirs carry BOTH `content.md` and a diverging hand-written `SKILL.md`: `attio-interaction`, `swarm-scripts` (seeded — `content.md` is live truth, `SKILL.md` is stale dead weight kept only for catalog remote-install), `agentmail-sending`, `kapso-whatsapp` (catalog-only — `SKILL.md` is what users install, `content.md` is dead weight). `skill-install-remote` (`src/tools/skills/skill-install-remote.ts:58-76`) fetches `<templatePath>/SKILL.md` from GitHub raw `main`.

## Desired End State

- `plugin/skills/` contains only `.gitkeep`; the 5 skills + 24 ai-toolbox skills are seeded `templates/skills/` entries with `runAllSeedersCandidate: true`, `systemDefault: true` (39 seeded skills total).
- `Dockerfile.worker` no longer installs ai-toolbox; agent-fs and qa-use installs plus the `cp -aL` mirror are untouched.
- Every `templates/skills/<name>/SKILL.md` that coexists with a `content.md` is byte-identical to the generated output of `config.json` + `content.md`, enforced in CI.
- `check-skill-sources` also fails on collisions between `templates/skills/` names and `Dockerfile.worker` `--skill` names.
- `scripts/sync-ai-toolbox-skills.ts` re-vendors from a manifest-pinned commit SHA; `--check` is network-free and CI-enforced.
- A fresh worker gets all 39 skills in all 5 harness trees via the DB path; a `templates/skills/` edit + API restart propagates to live workers without a container restart.

### End-state file structure (sketch)

```
templates/skills/
├── ai-toolbox.manifest.json         # NEW (Ph3): pinned commit SHA + per-file sha256 + exclude-list
│                                    #   (final location implementer's call — must stay out of the */config.json glob)
│
│ # ── migrated from plugin/skills/ (Ph2) ─────────────────────────────
├── composio/
│   ├── config.json                  #   { name, description, runAllSeedersCandidate: true, systemDefault: true }
│   ├── content.md                   #   body only, NO frontmatter — the single source
│   └── SKILL.md                     #   GENERATED by build:skill-md (kept: integrations-catalog templatePath)
├── composio-gmail/                  #   config.json + content.md only (no catalog ref → no SKILL.md twin)
├── composio-google-calendar/        #   〃
├── composio-google-docs/            #   〃
├── download-task-attachment/        #   〃
│
│ # ── vendored from ai-toolbox main (Ph3, 24 dirs) ───────────────────
├── planning/
│   ├── config.json
│   ├── content.md
│   └── files/
│       └── template.md              #   bundled file → skill_files row (isComplex)
├── script-builder/
│   ├── config.json
│   ├── content.md
│   └── files/templates/             #   nested bundled files: README.md, bash.sh.tmpl,
│                                    #   python.py.tmpl, typescript.ts.tmpl
├── v-planning/…  wts-expert/…       #   multi-file: files/{root.md,step.md} / files/COMMANDS.md
├── ask-user/  brainstorming/  code-reviewing/  delegate-work/  design-docs/
├── engineering-standards/  implementing/  improve-agents-md/  learning/  one-shot/
├── phase-running/  qa/  questioning/  researching/  reviewing/  step-running/
├── tackle-gh-comments/  tdd-planning/  v-implementing/  verifying/
│
│ # ── existing dirs after the twin cleanup (Ph1) ─────────────────────
├── attio-interaction/               #   seeded; SKILL.md now GENERATED from content.md (was stale hand-copy)
├── swarm-scripts/                   #   〃
├── agentmail-sending/               #   catalog-only; content.md ported FROM SKILL.md, SKILL.md regenerated
├── kapso-whatsapp/                  #   〃
└── …                                #   all other existing seeded/catalog dirs unchanged

plugin/skills/
└── .gitkeep                         # only file left (Ph2) — 5 dirs deleted, COPY lines dropped from both leaf blocks

src/be/seed-skills/
├── index.ts                         # +29 skills: 58 new text-imports + BUILT_IN_SKILL_SOURCES entries (Ph2+Ph3)
└── bundled-files.generated.json     # regenerated — now carries the vendored files/** too

scripts/
├── build-skill-md.ts                # NEW (Ph1): config.json+content.md → SKILL.md, --check in CI
├── sync-ai-toolbox-skills.ts        # NEW (Ph3): SHA-pinned vendor + transforms, --check in CI
└── check-skill-sources.ts           # +stale-skill-md rule (Ph1), +Dockerfile --skill collision rule (Ph3)

Dockerfile.worker                    # −COPY plugin/skills/ ×2 (Ph2); −ai-toolbox npx add + wts-expert assert (Ph3)
```

## What We're NOT Doing

- `plugin/commands/`, `plugin/agents/`, `plugin/pi-skills/` stay baked (per-harness content variants; no DB surface).
- `agent-fs` / `qa-use` skills stay baked (version-locked to their CLIs in the image).
- No boot-time fetching of upstream repos (research Option C rejected); no entrypoint changes (complex seeded skills land via the runner refresh before the first task prompt is built — verified path, `runner.ts:5086`).
- Not vendoring ai-toolbox `feedback`, nor `cc-plugin/base/{commands,agents,hooks}` (never installed today; not representable in the DB skill system).
- Not deduplicating repeated conventions *across* ai-toolbox skills upstream — vendor content as-is (minus frontmatter/path transforms).
- Not touching `skillSeedHash`, the entrypoint skill sync, or the 262 MB context-mode plugin layer.

## Implementation Approach

- Three phases ≈ two PRs: **Phase 1+2 → PR A** (twin cleanup + 5-skill migration), **Phase 3 → PR B** (ai-toolbox vendoring). Each phase gets a commit after verification passes (`[phase N] <desc>`).
- Order matters: the SKILL.md generator (Phase 1) must exist before composio's catalog `SKILL.md` sibling is created (Phase 2); the extended collision check (Phase 3, step 1) must land in the same PR that both seeds ai-toolbox names and drops the npx line — **atomically**, or the truncation bug re-arms silently.
- Reuse existing patterns wholesale: text-import wiring per `runbooks/skills.md:27-57`, manifest+check per `vendored-openapi`, generated-artifact-with-`--check` per `build-seed-skill-files`.

## Quick Verification Reference

```bash
bun run lint && bun run tsc:check && bun run test:root
bash scripts/check-db-boundary.sh && bun run check:dep-graph
# Skill-specific bundle (runbooks/skills.md:105-110):
bun run check:skill-sources
bun run build:seed-skill-files
bun run check:seed-skill-files
bun run test:root -- src/tests/seed-skills-bundled-files.test.ts \
                     src/tests/system-default-skills.test.ts \
                     src/tests/skill-fs-writer.test.ts \
                     src/tests/skill-sync.test.ts
```

---

## Phase 1: Single-source the SKILL.md twins (generator + CI rule)

### Overview

Deliverable: `bun run build:skill-md` regenerates every catalog-facing `SKILL.md` from `config.json` + `content.md`; the 4 dual-file dirs are reconciled; a new `check-skill-sources` rule fails CI on a stale twin; runbooks + repo notes teach the new workflow so nobody hand-edits a generated `SKILL.md` again.

### Changes Required:

#### 1. Generator script
**File**: `scripts/build-skill-md.ts` (new), `package.json` (scripts `build:skill-md`, `check:skill-md` or a `--check` flag)
**Changes**: For every `templates/skills/<name>/` that has BOTH `config.json` and `content.md` AND needs a `SKILL.md` (dir already has one, or is referenced by an integrations-catalog `templatePath`): write `SKILL.md` = exact `buildSkillContent()` output (`---\nname: …\ndescription: …\n---\n\n<content.md trimmed>\n`). Export/reuse the real `buildSkillContent` from `src/be/seed-skills/index.ts` — do not duplicate the format. `--check` mode diffs against committed files, exit 1 on drift (model: `scripts/build-seed-skill-files.ts:76-91`).

#### 2. Reconcile the 4 dual dirs
**Files**: `templates/skills/{attio-interaction,swarm-scripts,agentmail-sending,kapso-whatsapp}/`
**Changes**:
- `attio-interaction`, `swarm-scripts` (seeded): `content.md` wins; regenerate `SKILL.md` from it (stale hand-copy replaced). Diff old vs generated first — if the stale SKILL.md contains content improvements missing from content.md, fold them into content.md (implementer judgment; flag anything substantive in the PR description).
- `agentmail-sending`, `kapso-whatsapp` (catalog-only): `SKILL.md` wins; port its body into `content.md` (frontmatter stripped, description → `config.json`), then regenerate `SKILL.md`. These dirs stay `runAllSeedersCandidate: false` — no seeder wiring.

#### 3. CI rule
**Files**: `scripts/check-skill-sources.ts`, `.github/workflows/merge-gate.yml` (Seeded Skills Check job)
**Changes**: New rule `stale-skill-md`: any dir with both `content.md` and `SKILL.md` must have `SKILL.md` byte-equal to the generated output. Add `bun run build:skill-md --check` (or fold into `check:skill-sources`) to the Seeded Skills Check job.

#### 4. Runbooks + repo notes (same PR — the workflow must be documented where people actually look)
**Files**: `runbooks/skills.md`, `CLAUDE.md`, `runbooks/ci.md`
**Changes**:
- `runbooks/skills.md`: rewrite the "a `SKILL.md` beside a `content.md` is **not** a mistake" paragraph → `SKILL.md` is now a **generated artifact** of `config.json` + `content.md`; NEVER hand-edit it; regenerate with `bun run build:skill-md`; CI (`stale-skill-md`) rejects drift. Add the command to the runbook's verification bundle (`:105-110`) and to the authoring checklist (`:27-57`).
- `CLAUDE.md`: update the skills `<important>` block — add `build:skill-md` to the "Touched `files/`?"-style drift-check bullets (edited `content.md`/`config.json` in a dir that has a `SKILL.md`? → regenerate + commit) and to the commit-prep drift-check list in the CI `<important>` block.
- `runbooks/ci.md`: add the new check to the drift-checks table ("why CI fails" list).

### Success Criteria:

#### Automated Verification:
- [x] `bun run build:skill-md && bun run build:skill-md --check` passes; `git status` clean after regenerate
- [x] Deliberately editing a generated `SKILL.md` makes `--check` exit non-zero (demonstrate, then revert)
- [x] `bun run check:skill-sources` passes (rules 1–5 + new rule)
- [x] `bun run lint && bun run tsc:check && bun run test:root` pass
- [x] Seeder unit bundle passes: `bun run test:root -- src/tests/seed-skills-bundled-files.test.ts src/tests/system-default-skills.test.ts src/tests/skill-fs-writer.test.ts src/tests/skill-sync.test.ts`
- [x] Docs updated in the same commit: `grep -q "build:skill-md" runbooks/skills.md CLAUDE.md runbooks/ci.md` (all three hit)

#### Automated QA:
- [x] Fresh DB seed (`rm -f agent-swarm-db.sqlite* && bun run start:http`), then `curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/skills | jq '.skills[] | select(.name=="attio-interaction" or .name=="swarm-scripts") | {name, scope, version}'` — both present, scope `swarm`; their DB `content` matches the regenerated `content.md`-derived output (no drift introduced by reconciliation)

#### Manual Verification:
- [x] Taras eyeballs the reconciliation diffs for the 4 dirs (content-winner judgment calls) — approved on review summary 2026-08-03

**Post-review amendments (Taras, 2026-08-03)**: (1) `userInvocable` support added — optional `userInvocable: false` in `config.json` renders `user-invocable: false` frontmatter and threads through the seeder to the skill row (restores the field the old hand-written SKILL.md carried for attio-interaction / agentmail-sending / kapso-whatsapp; hash-stable for skills without the flag; attio's inert `agentAutoTrigger` blob dropped — zero code references). (2) The `stale-skill-md` rule was deduped out of `check-skill-sources.ts` — the invariant is enforced solely by `bun run check:skill-md` (alias for `build:skill-md --check`), mirroring the `build:`/`check:seed-skill-files` pattern. (3) `buildSkillContent`/`SkillTemplateConfig` extracted to leaf module `src/be/seed-skills/render.ts` so CI scripts don't import the db-coupled seeder index.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 1] single-source SKILL.md twins`.

---

## Phase 2: Migrate the 5 `plugin/skills/` into the seeder

### Overview

Deliverable: `composio`, `composio-gmail`, `composio-google-calendar`, `composio-google-docs`, `download-task-attachment` are seeded skills; `plugin/skills/` holds only `.gitkeep`; the composio catalog entry points at the new location. Same PR as Phase 1.

### Changes Required:

#### 1. Template dirs (×5)
**Files**: `templates/skills/<name>/{config.json,content.md}` (new ×5); `templates/skills/composio/SKILL.md` (generated via Phase 1 script)
**Changes**: Split each baked `SKILL.md`: frontmatter `name`/`description` → `config.json` with `runAllSeedersCandidate: true`, `systemDefault: true`; body → `content.md` (no frontmatter). Round-trip guard: generated `buildSkillContent()` output must byte-match the original baked `SKILL.md` (composio-google-calendar's description contains `trap: …` + embedded quotes — today's bake is identical raw YAML, so byte-parity is achievable; verify explicitly). Only composio gets a committed generated `SKILL.md` (catalog remote-install); the other 4 stay twin-less.

#### 2. Seeder wiring
**File**: `src/be/seed-skills/index.ts`
**Changes**: 10 static text-imports (2 per skill) + 5 `BUILT_IN_SKILL_SOURCES` entries (`index.ts:116-127`). No `files/` → no `build:seed-skill-files` delta (run it anyway to prove no-op).

#### 3. Delete baked copies + retire COPY
**Files**: `plugin/skills/{composio,composio-gmail,composio-google-calendar,composio-google-docs,download-task-attachment}/` (delete), `Dockerfile.worker`
**Changes**: Delete the 5 dirs (keep `plugin/skills/.gitkeep`). Drop `COPY --chown=worker:worker plugin/skills/ …` from BOTH leaf blocks (`:392` and `:610`) and adjust the adjacent comments — keep the two leaf blocks identical. **Do NOT touch the `cp -aL` mirror** (`:416-422`/`:634-640`) — it fans out agent-fs/qa-use. Confirm `scripts/check-skill-sources.ts` tolerates a `plugin/skills/` with no skill dirs.

#### 4. Catalog + docs
**Files**: `apps/ui/src/lib/integrations-catalog.ts:690`, `docs-site/content/docs/(documentation)/integrations/composio.mdx:133`, `runbooks/skills.md`, `CLAUDE.md` (skills `<important>` block if it still references the 5)
**Changes**: `templatePath: "templates/skills/composio"`; composio.mdx "bundled under plugin/skills/composio" → seeded-skill wording; runbook delivery-path table row for `plugin/skills/` updated (path retired for skills; commands/agents/pi-skills remain).

### Success Criteria:

#### Automated Verification:
- [x] `bun run check:skill-sources` passes (rule 1 proves no duplicate path; rule 5 passes with the moved templatePath; new-skill wiring satisfies rule 4)
- [x] `bun run build:seed-skill-files && bun run check:seed-skill-files` pass (no-op)
- [x] `bun run lint && bun run tsc:check && bun run test:root` pass; `bash scripts/check-db-boundary.sh`
- [x] `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b` (integrations-catalog touched)
- [x] `docker build -f Dockerfile.worker --target worker-slim .` succeeds; `docker build -f Dockerfile.worker --target worker-full .` locally (merge gate only builds slim)
- [x] Fresh AND existing DB boot: `rm -f agent-swarm-db.sqlite* && bun run start:http` then restart over the same DB — seeder creates then no-ops (`skippedUpToDate` — observed `unchanged=15`)

#### Automated QA:
- [x] Docker E2E smoke (copy from `LOCAL_TESTING.md:57-81`):
  ```bash
  rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
  bun run start:http &
  bun run docker:build:worker:slim
  SUFFIX=$(git branch --show-current | tr '/' '-')
  docker run --rm -d --name e2e-lead-$SUFFIX --env-file .env.docker-lead \
    -e AGENT_ROLE=lead -e MAX_CONCURRENT_TASKS=1 -p 3201:3000 agent-swarm-worker:slim
  docker run --rm -d --name e2e-worker-$SUFFIX --env-file .env.docker \
    -e MAX_CONCURRENT_TASKS=1 -p 3203:3000 agent-swarm-worker:slim
  sleep 15
  curl -s -H "Authorization: Bearer 123123" http://localhost:3013/api/agents \
    | jq '.agents[] | {name, isLead, status}'
  ```
- [x] Harness-tree check (new, not in LOCAL_TESTING.md): after the worker's runner boots (give it ~30 s), `for t in .claude/skills .pi/agent/skills .codex/skills .opencode/skills .agents/skills; do docker exec e2e-worker-$SUFFIX ls /home/worker/$t; done` — all 5 migrated skills present in all 5 trees, each dir containing a `.swarm-managed` marker (25/25 verified)
- [x] Two-pass stability: trigger a second refresh (send any pool task via `curl -X POST …/api/tasks` per LOCAL_TESTING.md, or restart the worker container) — the 5 skill dirs survive unchanged (real pool task completed through the worker; dirs + markers intact, timestamps unchanged)
- [x] `curl -s -H "Authorization: Bearer 123123" "http://localhost:3013/api/agents/<workerId>/skills" | jq '[.skills[].name]'` includes all 5 with `isActive: true` (15 total)
- [x] Cleanup: `docker stop e2e-lead-$SUFFIX e2e-worker-$SUFFIX; kill $(lsof -ti :3013)` (ran on ports 3999/3211/3213 to leave the dev stack on 3013 untouched)

#### Manual Verification:
- [x] Dashboard `/skills` page: the 5 appear with scope `swarm`, System Default badge, a version; detail page shows the edit-lock (verified by Claude via agent-browser on the worktree stack per Taras's delegation; screenshots at /tmp/qa-skills-final.png, /tmp/qa-composio-detail.png)
- [x] Composio integration setup flow still resolves the skill from the new templatePath (Settings → Integrations → Composio shows the recommended `composio` template skill with install actions; note: actual remote fetch resolves against GitHub raw `main`, so it 404s until PR A merges — and the skill is seeded+systemDefault now anyway, so remote install is redundant for it)

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 2] migrate plugin/skills into seeder`; open PR A (Phases 1+2).

**Post-review amendment (2026-08-03)**: the 5 new `config.json` files were extended from the minimal seeder shape to the full `AgentAssetConfig` shape (`templates/schema.ts`) — `apps/templates-ui` reads `templates/skills/*/config.json` directly and `asset-detail.tsx` dereferences `config.placeholders.length`, so the minimal shape would crash the templates registry pages. Placeholders: `COMPOSIO_API_KEY` on the hub skill only; runtime-injected env (`AGENT_SWARM_*`, `MCP_BASE_URL`) is not a placeholder.

---

## Phase 3: Vendor ai-toolbox (sync script + seed + drop the npx bake)

### Overview

Deliverable: 24 ai-toolbox skills vendored under `templates/skills/` from a SHA-pinned sync script; `Dockerfile.worker` no longer installs ai-toolbox; `check-skill-sources` catches templates-vs-Dockerfile collisions. One atomic PR (PR B).

### Changes Required:

#### 1. Collision guard first
**File**: `scripts/check-skill-sources.ts`
**Changes**: Extend `duplicate-delivery-path`: parse `Dockerfile.worker` for `npx … skills … add` `--skill <name>` flags and fail on any name also present in `templates/skills/`. This makes the vendor+drop atomicity CI-enforced rather than convention.

#### 2. Sync script + manifest
**Files**: `scripts/sync-ai-toolbox-skills.ts` (new), `templates/skills/ai-toolbox.manifest.json` (new; or `scripts/`-adjacent — implementer's call, keep it out of the skill-dir glob), `package.json` (`sync:ai-toolbox-skills`, `check:ai-toolbox-skills`)
**Changes**: Model on `refresh-vendored-openapi.ts`/`check-vendored-openapi.ts`:
- **Skill set**: all `cc-plugin/base/skills/*` EXCEPT `feedback`, plus `cc-plugin/wts/skills/wts-expert` (explicit exclude-list in the manifest, so new upstream skills are picked up by default on re-sync).
- **Pin**: sync resolves `desplega-ai/ai-toolbox` `main` → records commit SHA + per-file sha256 in the manifest. Re-pin = re-run with `--ref <sha|tag>`.
- **Transforms per skill**: strip frontmatter → `content.md`; `description` → `config.json` (`runAllSeedersCandidate: true`, `systemDefault: true`); **assert** description is single-line YAML-plain-safe (no `": "`, no leading indicator — `buildSkillContent` interpolates raw); drop `hooks:` frontmatter (inert today); sibling files → `files/**` (assert text-only, non-executable, within `SKILL_FILE_LIMITS` 100/500 KB/10 MB); rewrite repo-absolute `cc-plugin/…` references to skill-relative paths; assert no name collision with existing `templates/skills/`.
- **`--check`**: network-free — re-verify committed outputs are internally consistent with the manifest (per-file hashes), fail on drift.
- After sync: run `bun run build:seed-skill-files` and commit the regenerated manifest.

#### 3. Seeder wiring
**File**: `src/be/seed-skills/index.ts`
**Changes**: 48 static text-imports + 24 `BUILT_IN_SKILL_SOURCES` entries (mechanical one-time edit; guarded by check-skill-sources rule 4 — deliberately not codegen'd, keep the seeder file boring).

#### 4. Drop the bake
**File**: `Dockerfile.worker`
**Changes**: Delete lines 222-227 (the ai-toolbox `add` within the chained RUN — reconnect line 221's continuation to the asserts) and line 230 (`test -e …/wts-expert/SKILL.md`). Keep agent-fs add + assert (`:221`, `:229`) and qa-use (`:583-586`). Touch up the comment block (`:206-216`). Leaf blocks are untouched in this phase.

#### 5. CI + docs
**Files**: `.github/workflows/merge-gate.yml:98` (`SEED_SKILLS` filter regex += `scripts/sync-ai-toolbox-skills.ts` + manifest path; add `check:ai-toolbox-skills` to the Seeded Skills Check job), `runbooks/skills.md` (new "vendored ai-toolbox" section: source of truth = upstream repo, re-sync procedure, exclude-list), `runbooks/docker-images.md` (skills-install paragraph now covers agent-fs/qa-use only)
**Changes**: as listed.

### Success Criteria:

#### Automated Verification:
- [x] `bun run sync:ai-toolbox-skills` is idempotent (second run = no diff); `bun run check:ai-toolbox-skills` passes; deliberate edit of a vendored `content.md` fails it (demonstrate, revert — demonstrated twice, incl. against the live-update probe edit)
- [x] Collision guard proves itself: with the npx line still present mid-implementation, `bun run check:skill-sources` FAILS (18 collisions); after the Dockerfile drop it passes (50 seeded / 0 plugin-baked / 2 docker-installed)
- [x] `bun run build:seed-skill-files && bun run check:seed-skill-files` pass (multi-file skills land in the generated manifest — 15 complex skills)
- [x] `bun run lint && bun run tsc:check && bun run test:root` (6798 pass incl. new `src/tests/sync-ai-toolbox-skills.test.ts`); `bash scripts/check-db-boundary.sh && bun run check:dep-graph`
- [x] `docker build -f Dockerfile.worker --target worker-slim .` AND `--target worker-full .` succeed; `docker run --rm agent-swarm-worker:slim ls /home/worker/.claude/skills` shows NO ai-toolbox skills baked, agent-fs still present (full additionally qa-use)
- [x] Fresh + existing DB boot both seed 39 skills (fresh `created=39`, restart `unchanged=39`)

#### Automated QA:
- [x] Repeat the Phase 2 Docker E2E smoke + harness-tree check with the new slim image: all 24 vendored skills (including multi-file ones — `planning/template.md`, `script-builder/templates/`, `wts-expert/COMMANDS.md`) present in all 5 trees — 24/24 × 5 with `.swarm-managed` markers
- [x] Two-pass stability for a multi-file vendored skill: second refresh pass does not prune `planning/template.md` (all 9 spot-checked bundled files survive post-task; zero pruning log lines)
- [x] Live-update propagation: edit a vendored `content.md` locally (scratch edit), restart the API, wait for the worker's next poll trigger → `docker exec … cat …/planning/SKILL.md` reflects the change without container restart; revert the scratch edit + reseed (verified both directions: probe arrived at worker boot-refresh; sync-script revert propagated mid-life at next task claim, `.claude` + `.pi` trees)
- [x] Send one real task through the worker (LOCAL_TESTING.md pool-task flow) and confirm the task session can read a vendored skill (e.g. logs show skills refresh + no `.swarm-managed` pruning warnings) — two tasks completed through the worker

**Review round (2026-08-03)**: Spec (Opus) — clean, all 24 bodies/descriptions/bundled files verified byte-identical to upstream at the pin. Standards (Opus) — 1 real Critical fixed (CWD-relative rewrites in executable command lines → now `~/.claude/skills/<name>/…` with exact-occurrence-count guards), 3 Importants fixed (unit-test coverage added, manifest `syncedVia` provenance, delegate-work rewrite restructure), all Minors fixed (canonical JSON, single comparator, display-name overrides, Dockerfile comment filtering, etc.). One reviewer Critical was a false positive (the live-update probe scratch edit).

#### Manual Verification:
- [x] Taras spot-checks 2–3 vendored skills' rendered content (approved 2026-08-03 on the Opus spec-review evidence — all 24 bodies diffed byte-identical to the pinned upstream)
- [x] Decide timing of the prod deploy — stacked PRs (Taras, 2026-08-03): PR B bases on PR A's branch, auto-retargets to main on A's merge; merge order A→B enforced by the stack, Taras picks B's merge moment

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 3] vendor ai-toolbox skills, drop image bake`; open PR B.

---

## Appendix

- **Follow-up plans**: none planned — agent-fs/qa-use migration explicitly rejected (research Option D).
- **Derail notes**:
  - `runbooks/skills.md` key-files table oversells the entrypoint as "boot-time skill sync" (it writes simple skills to 3 of 5 trees, no marker); pre-existing, worth a one-line fix while editing the runbook in Phase 3.
  - Entrypoint's legacy `npx skills add sourceRepo` fallback (`docker-entrypoint.sh:786-795`) logs a per-boot warning for every complex seeded skill ("no sourceRepo; skipping"). With 12+ complex skills post-Phase-3 that's noisy — consider demoting the log line (not load-bearing).
  - `ask-user` skill instructs `AskUserQuestion`, which worker settings deny — pre-existing upstream issue, unchanged by vendoring.
  - The `wts-expert` skill references the `wts` CLI baked in the image — fine (CLI stays baked), but it's the one vendored skill with an image-side dependency.
- **References**:
  - Research: `thoughts/taras/research/2026-07-31-baked-skills-to-db-seeding.md`
  - PR #1044 (de-collide + bundled-file seeding), PR #1060 (API-readiness gate)
  - `runbooks/skills.md`, `runbooks/docker-images.md`, `runbooks/ci.md`
  - Precedent: `scripts/refresh-vendored-openapi.ts` / `scripts/check-vendored-openapi.ts`
