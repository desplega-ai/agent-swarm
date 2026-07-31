# Skills — authoring and delivery

How a skill reaches an agent, which path to use, and what CI enforces.

## The three delivery paths

They are **not** interchangeable. Pick deliberately.

| # | Path | Source | Reaches agents by | Use when |
|---|---|---|---|---|
| 1 | **Seeded** ⭐ | `templates/skills/<name>/{config.json,content.md,files/}` | Embedded into the API binary at build time → written to the DB at boot → synced to every harness skill tree | Default for anything the swarm owns |
| 2 | **Baked** | `plugin/skills/<name>/SKILL.md` | `COPY` into the worker image | Only when the skill must exist before the API is reachable, or is version-locked to a CLI in the image |
| 3 | **Remote-installed** | a `SKILL.md` at a path the integrations catalog points at | `skill-install-remote` fetches `<templatePath>/SKILL.md` from GitHub raw, on demand | Optional per-integration skills the operator opts into |

**Prefer path 1.** Seeded skills are live-updatable without an image rebuild, listed by the skills API, editable in the UI, per-agent toggleable, and version-tracked with user-edit preservation. Baked skills have none of that.

> Paths 1 and 3 can coexist in the same directory. A `SKILL.md` sitting beside a `content.md` is **not** a mistake — the seeder reads `content.md`, and remote-install reads `SKILL.md`. `attio-interaction`, `agentmail-sending`, `kapso-whatsapp` and `swarm-scripts` do exactly this. If you edit one, consider whether the other needs the same change.

## The rule that matters

**One skill name must not be both seeded (1) and baked (2).**

Both write `~/.claude/skills/<name>/SKILL.md`. The DB copy wins at runtime, so the baked content is silently discarded — and then `writeSkillsToFilesystem` drops a `.swarm-managed` marker, after which `reconcileManagedSkillFiles` deletes any file in that directory with no `skill_files` row.

This is not hypothetical. `artifacts`, `kv-storage` and `pages` each existed in both paths with different content. Agents were served the smaller version and lost the bundled examples. Enforced by `bun run check:skill-sources`.

## Adding a seeded skill

```
templates/skills/<name>/
  config.json          # name (must equal the directory), description,
                       # runAllSeedersCandidate, systemDefault
  content.md           # the SKILL.md body — NO frontmatter; it is generated
                       # from config.json's name + description
  files/               # optional bundled files → skill_files rows
    examples/foo.ts    # arrives at ~/.claude/skills/<name>/examples/foo.ts
```

1. Create the directory as above.
2. Add **static** text-imports for `config.json` and `content.md` in `src/be/seed-skills/index.ts`, then an entry in `BUILT_IN_SKILL_SOURCES`.
   They must be static: the API runs from a `bun build --compile` binary and `templates/` only exists in the Dockerfile's builder stage, so nothing can be read from disk at runtime.
3. Added anything under `files/`? Run `bun run build:seed-skill-files` and commit `src/be/seed-skills/bundled-files.generated.json`. Never hand-edit that file.
4. Run `bun run check:skill-sources` and the skill tests.

### config.json flags

| Flag | Effect |
|---|---|
| `runAllSeedersCandidate: true` | Seeds it. Without this the template is inert — an on-demand catalog entry only. |
| `systemDefault: true` | Installs it for **every** agent. Any `scope='swarm'` skill already reaches all agents with no `agent_skills` row; this additionally marks it as a default. |

### Bundled-file constraints

- **Text only.** `skill_files.content` is `TEXT` and the FS writer skips binaries.
- **Executable bits are not preserved** — a bundled `.sh` arrives non-executable.
- Limits (`SKILL_FILE_LIMITS`): 100 files, 500 KB per file, 10 MB total.
- `SKILL.md` is rejected as a bundled path — the body lives on the skill row.

## How versioning works

The seeder never clobbers a user's edits. Per skill, per run:

| Upstream state | Action |
|---|---|
| absent | create |
| pristine, source changed | update |
| pristine, source unchanged | no-op |
| user-modified | **preserve** — never overwritten again |

"Pristine" means the live DB copy still hashes to what the seeder last wrote (`seed_state`). Bundled files are part of that hash, so editing one is drift exactly like editing `content.md`.

> **Do not change the hash format lightly.** The bundled-file section is appended **only when a skill has files**, so file-less skills hash byte-identically to the pre-bundled-files scheme. If every skill switched format at once, no `seed_state` row written by an earlier release would match, every already-seeded skill would be classified user-modified, and the seeder would silently stop updating them forever. `src/tests/seed-skills-bundled-files.test.ts` covers this upgrade path — keep it passing.

## What CI enforces

`bun run check:skill-sources` (job: **Seeded Skills Check**):

| Rule | Catches |
|---|---|
| `duplicate-delivery-path` | A name that is both seeded and baked — the collision above |
| `name-mismatch` | `config.json` name ≠ directory name (bundled files are keyed by directory) |
| `missing-content` | `runAllSeedersCandidate: true` with no `content.md` |
| `not-wired` | A seeded template nobody imported — it would never reach an agent |
| `missing-remote-skill` | An integrations-catalog `templatePath` with no `SKILL.md` — remote install would 404 |

Also in that job: `bun run check:seed-skill-files` (manifest freshness) and the skill seeder tests.

> The job is gated on its **own** change flag, not `lint`/`test`. Neither of those matches `templates/`, so without a dedicated flag a bundled-file-only PR would run nothing but the Docker build and could merge a stale manifest — shipping a compiled API that seeds old or missing files.

## Commands

```bash
bun run check:skill-sources        # source-of-truth invariants
bun run build:seed-skill-files     # regenerate the bundled-file manifest
bun run check:seed-skill-files     # manifest freshness (CI)
bun run test:root -- src/tests/seed-skills-bundled-files.test.ts \
                     src/tests/system-default-skills.test.ts \
                     src/tests/skill-fs-writer.test.ts \
                     src/tests/skill-sync.test.ts
```

Verify end to end against a fresh DB (`rm agent-swarm-db.sqlite && bun run start:http`) and confirm the skill lands in every harness tree, not just `~/.claude/skills/`.

## Key files

| File | Role |
|---|---|
| `src/be/seed-skills/index.ts` | Catalog + seeder. `BUILT_IN_SKILL_SOURCES` is the wiring list |
| `src/be/seed-skills/bundled-files.generated.json` | Generated — never hand-edit |
| `scripts/build-seed-skill-files.ts` | Manifest generator + `--check` |
| `scripts/check-skill-sources.ts` | Invariant enforcement |
| `src/be/seed/runner.ts` | Generic pristine-vs-user-modified harness |
| `src/utils/skill-fs-writer.ts` | Writes to all five harness trees; owns `.swarm-managed` reconcile |
| `src/utils/skills-refresh.ts` | Worker-side live refresh (mid-session, no restart) |
| `docker-entrypoint.sh` | Boot-time skill sync |
