---
date: 2026-07-31
researcher: Claude (Opus 5)
git_commit: 3dbe4ae2
branch: main
repository: agent-swarm
topic: "Moving image-baked worker skills into the DB skill-seeding system"
tags: [research, skills, docker-images, seeders, worker-boot]
status: complete — decisions resolved, ready for create-plan
last_updated: 2026-07-31
---

# Moving image-baked skills into the DB skill-seeding system

## Research Question

Can we stop baking skills into the worker images and instead auto-seed them into the skill
system on startup (as we already do for the repo `templates/skills/` ones), to make workers
boot faster and be smaller by default? What are the options and the complexity?

## TL;DR

The **size and boot-speed premise does not hold.** Skills are ~1.5 MB of a 1.96 GB slim image
(0.08%) and are baked in, so they cost **zero** boot time today. Moving them to DB seeding
adds per-boot work, not removes it.

Do it anyway, for **update velocity, build reproducibility, and collapsing the parallel
delivery paths** — and because the two existing paths are **already silently corrupting three
skills in production** (see [Live bug](#live-bug-already-in-production)).

**Decided:** Option B, scoped to `plugin/skills/` first, then vendored ai-toolbox. See
[Decisions](#decisions-2026-07-31).

---

## Measured facts

### Size

Isolated the real layers (a naive `grep skill` over `docker history` matches every layer,
because `SKILLS_CLI_VERSION` is in the build-arg prefix of every `RUN` after it is declared):

| Layer | slim | full |
|---|---|---|
| `npx skills add` (agent-fs + 18 ai-toolbox skills) | 213 kB | 213 kB |
| `npx skills add qa-use` | — | 94.9 kB |
| harness-tree mirror (`cp -aL` × 5) | 1.14 MB | 1.48 MB |
| `COPY plugin/skills/` | 59.6 kB | 59.6 kB |
| `COPY plugin/pi-skills/` | 33.2 kB | 33.2 kB |
| `COPY plugin/commands/` → codex | 33.5 kB | 33.5 kB |
| **Total skill footprint** | **~1.5 MB / 1.96 GB** | **~1.9 MB / 4.22 GB** |

On-disk in the image: 420 KB per harness tree × 5 trees, 27 skills.

**The big fish in the full image is the 262 MB `context-mode` plugin-marketplace layer** —
and that is *not* a skill. It ships `ctx_*` hooks, which a skills-only mechanism cannot
replace. No skill-seeding change touches it.

### Boot

Skills are baked → **0 ms boot cost today**. The entrypoint already runs a skill sync
(`docker-entrypoint.sh:706-763`) that curls `/api/agents/<id>/skills` and writes SKILL.md
files, and the runner does a live hash-cached refresh per task
(`src/utils/skills-refresh.ts`). Moving skills into that path means additional directory
writes (N skills × 5 trees) per boot — tens of ms, negligible but **slower, not faster**.

The one genuine boot-time win: the entrypoint's legacy `npx skills add "$repo"` fallback for
`isComplex` skills that only have a `sourceRepo` (`docker-entrypoint.sh:740-746`). That is a
runtime network install. DB-backed complex skills bypass it entirely.

### Binaries / permissions

All bundled files across the 27 baked skills are text (`.md`, `.ts`, `.sh`, `.tmpl`, `.py`).
No binary assets → the `isBinary` skip in `skill-fs-writer.ts:169` is not a blocker.
Executable bits are **not** preserved by `writeFileSync`, but no baked skill relies on one
(the `.sh`/`.tmpl` files are templates, not executed in place).

---

## What already exists (most of the machinery is built)

| Capability | Where | Status |
|---|---|---|
| Seeder harness w/ pristine-vs-user-modified tracking | `src/be/seed/runner.ts`, migration `070_seed_state.sql` | Done |
| Skills seeder | `src/be/seed-skills/index.ts`, registered in `src/be/seed/registry.ts` | Done, **simple skills only** |
| Multi-file skill storage | migration `087_skill_files.sql`, `upsertSkillFiles()` (`db.ts:11230`) | Done |
| Multi-file HTTP surface | `POST /api/skills/{id}/files` (`src/http/skills.ts:101`) | Done |
| FS fan-out to all 5 harness trees | `src/utils/skill-fs-writer.ts` | Done |
| Marker-scoped cleanup (`.swarm-managed`) | `skill-fs-writer.ts:44` | Done |
| Auto-delivery to every agent | `scope='swarm'` OR `systemDefault=1` in `getAgentSkills()` (`db.ts:11399`) | Done |
| Boot sync + live per-task refresh | `docker-entrypoint.sh:706`, `src/utils/skills-refresh.ts` | Done |

**Seeding a swarm-scope skill already reaches every agent with no `agent_skills` row.**

### The real gaps

1. **The seeder cannot seed multi-file skills.** `skillsSeeder.apply()` only writes
   `content`; it never calls `upsertSkillFiles`.
2. **The template source list is hardcoded.** `BUILT_IN_SKILL_SOURCES`
   (`seed-skills/index.ts:80`) is a static array fed by ~20 hand-written
   `import ... with { type: "text" }` statements. Every new skill needs 2 more imports.
3. **The ai-toolbox/agent-fs/qa-use skills are external**, pinned to
   `desplega-ai/ai-toolbox@cc-desplega-2.0.0`, `desplega-ai/agent-fs@v0.10.1`,
   `desplega-ai/qa-use@v2.19.0`.

> **Correction to an earlier draft of this doc:** the 11 `templates/skills/` dirs not wired
> into `BUILT_IN_SKILL_SOURCES` all carry `"runAllSeedersCandidate": false`. That is a
> deliberate opt-out (on-demand catalog templates), **not** staleness.

---

## Exact current state of `plugin/skills/` (answers "aren't these already seeded?")

Only **3 of 8** are. The other 5 exist nowhere in the DB:

| skill | baked (`plugin/skills/`) | seeded (`templates/skills/`) | status |
|---|---|---|---|
| `artifacts` | ✅ 7,075 B + 4 example files | ✅ 3,553 B, `systemDefault` | **collision + drift** |
| `kv-storage` | ✅ 7,373 B | ✅ 3,393 B, `systemDefault` | **collision + drift** |
| `pages` | ✅ 18,242 B | ✅ 11,646 B, `systemDefault` | **collision + drift** |
| `composio` | ✅ | ❌ | baked only |
| `composio-gmail` | ✅ | ❌ | baked only |
| `composio-google-calendar` | ✅ | ❌ | baked only |
| `composio-google-docs` | ✅ | ❌ | baked only |
| `download-task-attachment` | ✅ | ❌ | baked only |

So Phase 1 is **not** a pure refactor: 5 skills genuinely need migrating, and 3 need a
drift reconciliation that is a live bug fix.

### Live bug (already in production)

The three collisions both write `~/.claude/skills/<name>/SKILL.md`. Sequence per worker:

1. Image ships the baked version (richer — roughly 2× the bytes, plus `examples/*.ts`).
2. Entrypoint skill sync (`docker-entrypoint.sh:720-735`) overwrites `SKILL.md` with the
   smaller DB version via raw shell `echo`.
3. Runner's `refreshSkillsIfChanged` → `writeSkillsToFilesystem` rewrites `SKILL.md` **and
   drops a `.swarm-managed` marker**.
4. The next reconcile pass sees the marker, finds `skill.files` empty (the DB rows are simple
   skills), and **deletes `artifacts/examples/*.ts` + `examples/static-report.sh`**
   (`skill-fs-writer.ts:47`).

Net: agents get a truncated `artifacts`/`kv-storage`/`pages` and lose the bundled examples.
This is the strongest argument for consolidating — the two paths are already fighting.

---

## What cannot move (and why)

### `plugin/commands/` — per-harness content variants

One source, three destinations, **different bytes each**:

- `~/.claude/commands/` — Claude Code **slash commands**, raw (incl. `argument-hint`
  frontmatter and `<!-- claude-only -->` blocks)
- `~/.codex/skills/<name>/SKILL.md` — raw file copied as a skill
- `~/.pi/agent/skills/<name>/SKILL.md` — generated by `plugin/build-pi-skills.ts`, a
  ~200-line / 16-step regex pipeline (strips `claude-only`, reveals `pi-only`, rewrites
  `/cmd` → `/skill:cmd`, rewrites `/desplega:*` refs, renumbers list steps, strips emoji)

The DB stores **one** `content` per skill and `writeSkillsToFilesystem` writes identical bytes
to all five trees. Seeding commands would flatten the variants. Supporting them properly means
adding per-harness content to the skills schema **and** porting the transform pipeline
server-side.

### `~/.claude/commands/` and `plugin/agents/` — no DB surface at all

`writeSkillsToFilesystem` only targets skill directories. There is no commands surface and no
subagent-definition surface (`plugin/agents/` ships 4: `codebase-analyzer`,
`codebase-locator`, `codebase-pattern-finder`, `web-search-researcher`).

**Both stay baked.**

---

## Options (for the record)

| | Description | Effort | Verdict |
|---|---|---|---|
| **A** | Seeder gaps only (multi-file + glob discovery), images untouched | ~0.5 d | Folded into Phase 1 |
| **B** | Vendor + seed swarm-owned skills, drop from image | ~2–3 d | **Chosen** |
| **C** | Fetch upstream tags at API boot instead of vendoring | ~2 d | Rejected — converts a build-time network dep into a boot-time one; API boot is a far worse place to fail |
| **D** | B + also migrate `agent-fs` / `qa-use` | B + 0.5 d | Rejected — both are thin wrappers over CLIs in `/opt/global-deps`; `AGENT_FS_VERSION` intentionally pins skill and CLI in lockstep (`Dockerfile.worker:212`). Splitting invites version skew |

---

## Decisions (2026-07-31)

1. **Scope: `plugin/skills/` first, ai-toolbox second.** `plugin/commands/` and
   `plugin/agents/` stay baked (per-harness variants + no DB surface).
2. **ai-toolbox: vendor + sync script.** Copy into `templates/skills/` with a script that
   re-pulls the pinned tag; upstream `desplega-ai/ai-toolbox` stays source of truth and drift
   is detectable in CI.
3. **No baked fallback.** Instead, add a **worker-boot API-readiness wait with a timeout —
   worker exits if the API never becomes ready.** A worker that can't reach the API can't
   poll tasks anyway, so a half-provisioned worker is worse than a dead one. This is a
   standalone improvement worth having regardless of the skills work.
4. **Fix the live collision bug as a standalone PR first**, ahead of the migration.

---

## Sequencing

**Phase 0 — live bug fix (standalone PR, ~1 day)**
- Multi-file support in `skillsSeeder`: discover `templates/skills/<name>/files/**`, write via
  `upsertSkillFiles`.
- Reconcile `artifacts` / `kv-storage` / `pages` drift — decide which version wins per skill
  (the baked ones are richer; likely promote those into `templates/skills/`).
- Seed `artifacts`'s 4 example files as `skill_files` so reconcile stops deleting them.
- Regression test: seeded multi-file skill survives two consecutive refresh passes.

**Phase 1 — migrate `plugin/skills/` (~1 day)**
- Move the 5 baked-only skills (`composio`, `composio-gmail`, `composio-google-calendar`,
  `composio-google-docs`, `download-task-attachment`) into `templates/skills/`.
- Replace the hardcoded `BUILT_IN_SKILL_SOURCES` import list with directory discovery.
- Drop `COPY plugin/skills/` and the `cp -aL` mirror from **both** leaf stages.

**Phase 2 — worker API-readiness gate (~0.5 day, independent)**
- Poll `/api/health` (or equivalent) at entrypoint with a bounded timeout; exit non-zero on
  timeout. Emit a clear log line. Make the timeout an operator-tunable env var → register it
  in `apps/ui/src/lib/configuration-catalog.ts` per CLAUDE.md.

**Phase 3 — vendor ai-toolbox (~1–1.5 days)**
- Vendor the 18 skills into `templates/skills/`; add `scripts/sync-ai-toolbox-skills.ts`
  pinned to the tag + a CI drift check.
- Drop the `ai-toolbox` `npx skills add` block from `worker-base`. Keep `agent-fs` + `qa-use`.

**Verification (every phase)**
- `bun run tsc:check`, `bun run lint`, `bun run test:root`
- `bash scripts/check-db-boundary.sh`
- Fresh DB (`rm agent-swarm-db.sqlite && bun run start:http`) **and** existing DB
- E2E: fresh worker → assert all 5 harness trees populate, bundled files survive two refresh
  passes, and a mid-session `templates/skills/` edit propagates without a container restart

---

## Remaining cleanup spotted (not blocking)

4 `templates/skills/` dirs carry **both** `content.md` and a diverging `SKILL.md`
(`agentmail-sending`, `attio-interaction`, `kapso-whatsapp`, `swarm-scripts`). The seeder
reads only `content.md`, so the `SKILL.md` copies are dead weight — and for the two that *are*
seeded (`attio-interaction`, `swarm-scripts`) they're a drift trap. Delete or reconcile.
