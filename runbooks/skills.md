# Skills — authoring and delivery

How a skill reaches an agent, which path to use, and what CI enforces.

## The three delivery paths

They are **not** interchangeable. Pick deliberately.

| # | Path | Source | Reaches agents by | Use when |
|---|---|---|---|---|
| 1 | **Seeded** ⭐ | `templates/skills/<name>/{config.json,content.md,files/}` | Embedded into the API binary at build time → written to the DB at boot → synced to every harness skill tree | Default for anything the swarm owns |
| 2 | **Baked** | `plugin/{commands,agents,pi-skills}/` or pinned `npx skills` installs in `Dockerfile.worker` (`plugin/skills/` is retired) | Copied or installed into the worker image | Only for harness-specific commands/agents, Pi-only skills, or third-party skills version-locked to a CLI in the image (currently `agent-fs` and `qa-use`) |
| 3 | **Remote-installed** | a `SKILL.md` at a path the integrations catalog points at | `skill-install-remote` fetches `<templatePath>/SKILL.md` from GitHub raw, on demand | Optional per-integration skills the operator opts into |

**Prefer path 1.** Seeded skills are live-updatable without an image rebuild, listed by the skills API, editable in the UI, per-agent toggleable, and version-tracked with user-edit preservation. Baked skills have none of that.

> Paths 1 and 3 can coexist in the same directory. In that case, `SKILL.md` is a **generated artifact** of `config.json` + `content.md`; never hand-edit it. Run `bun run build:skill-md` and commit the result. CI (`bun run check:skill-md`) rejects drift.

## The rule that matters

**One skill name must not be both seeded (1) and baked as a skill.**
`plugin/skills/` is retired for skills; `plugin/commands/`, `plugin/agents/`,
and `plugin/pi-skills/` remain baked image assets.

When both delivery paths write `~/.claude/skills/<name>/SKILL.md`, the DB copy
wins at runtime, so the baked content is silently discarded — and then
`writeSkillsToFilesystem` drops a `.swarm-managed` marker, after which
`reconcileManagedSkillFiles` deletes any file in that directory with no
`skill_files` row.

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
3. Does the directory already have a `SKILL.md`, or does an integrations-catalog entry point at it? Run `bun run build:skill-md` and commit the generated file. Never hand-edit it.
4. Added anything under `files/`? Run `bun run build:seed-skill-files` and commit `src/be/seed-skills/bundled-files.generated.json`. Never hand-edit that file.
5. Run `bun run check:skill-sources` and the skill tests.

### config.json flags

| Flag | Effect |
|---|---|
| `runAllSeedersCandidate: true` | Seeds it. Without this the template is inert — an on-demand catalog entry only. |
| `systemDefault: true` | Installs it for **every** agent. Any `scope='swarm'` skill already reaches all agents with no `agent_skills` row; this additionally marks it as a default. |

### Bundled-file constraints

- **Text only.** `skill_files.content` is `TEXT` and the FS writer skips binaries.
- **Executable bits are not preserved** — a bundled `.sh` arrives non-executable.
- Invoke executable-text helpers with their interpreter (for example,
  `bash scripts/codex-exec.sh`), never by relying on a source executable bit.
- Limits (`SKILL_FILE_LIMITS`): 100 files, 500 KB per file, 10 MB total.
- `SKILL.md` is rejected as a bundled path — the body lives on the skill row.

## Skills the system prompt points at

The v2 system prompt (`src/prompts/session-templates.ts`, `src/prompts/base-prompt.ts`)
carries branches and pointers; the reference material lives in skills. These
seeded skills are named by the prompt, five of them with a MUST pointer:

| Skill | Pointer in the prompt | Holds |
|---|---|---|
| `swarm-scripts` | MUST, worker bulk/repeat branch; secrets block | rubric, authoring contract, seed catalog, connections and secrets, `db_query`, script APIs |
| `memory` | MUST, before store/edit/delete | tools, what makes a good memory, scope, dedup, triage, lead promotion |
| `slack-interaction` | MUST, before any Slack post | engine-owned posts, the one-message rule, tools, unknown users, standing orders |
| `code-quality` | MUST, before push/PR/review (repository block) | gh/glab, PR checks, CI loop, merge policy, review rules, review-reply provenance |
| `heartbeat-runbook` | MUST, lead heartbeat checklist | cap policy, lift triggers, checklist and boot-triage steps |
| `scheduling` | plain pointer | `create-schedule` target types, timing, verify and repair |
| `pages`, `apps`, `agent-fs` | plain pointers (outputs block) | publishing, apps, the shared drive |
| `workflow-iterate` | plain pointer (lead) | building workflows |

Renaming or unseeding one of these breaks a prompt pointer. Change the template
and the skill in the same PR. Skill descriptions are written as pointers: the
trigger word first, one trigger per branch, no identity the body carries. Each
description costs every agent tokens on every turn (claude and pi load all
descriptions natively), so keep them short.

## Vendored ai-toolbox skills

The source of truth for these seeded skills is
[`desplega-ai/ai-toolbox`](https://github.com/desplega-ai/ai-toolbox), not the
generated directories under `templates/skills/`. The pinned commit, explicit
exclude-list, transform report, and per-output-file SHA-256 hashes live in
`templates/ai-toolbox.manifest.json`. `feedback` is deliberately excluded; all
other `cc-plugin/base/skills/*` directories plus
`cc-plugin/wts/skills/wts-expert` are discovered on each sync, so new upstream
base skills are included by default.

Re-pin and regenerate with:

```bash
bun run sync:ai-toolbox-skills --ref <sha>
bun run check:ai-toolbox-skills
```

Use `--repo <path-or-url>` to source a fetched local clone or a different
transport. Manifest `source` remains the canonical upstream identity; when the
transport differs, `syncedVia` records the local path or sanitized URL identity
used for that sync (URL credentials, query, and fragment data are omitted). The
commit SHA is the immutable content pin in both cases. The sync reads
Git objects at that commit, strips supported frontmatter, drops inert hooks,
rewrites prose references to skill-relative paths, rewrites executable and
`${CLAUDE_PLUGIN_ROOT}` references to `~/.claude/skills/<name>/...`, and vendors
sibling text files under `files/`. Executable text is retained but its
executable bit is intentionally downgraded and reported; invoke such helpers
with their interpreter, for example
`bash ~/.claude/skills/delegate-work/scripts/codex-exec.sh`. Binaries and
unsupported frontmatter keys fail the sync. Never hand-edit vendored
`config.json`, `content.md`, or `files/**`; update upstream, re-run the sync, and
commit the manifest and output together.

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

Also in that job: `bun run check:skill-md` (a generated `SKILL.md` that no longer matches `config.json` + `content.md`), `bun run check:seed-skill-files` (manifest freshness), and the skill seeder tests.

> The job is gated on its **own** change flag, not `lint`/`test`. Neither of those matches `templates/`, so without a dedicated flag a bundled-file-only PR would run nothing but the Docker build and could merge a stale manifest — shipping a compiled API that seeds old or missing files.

## Commands

```bash
bun run check:skill-sources        # source-of-truth invariants
bun run build:skill-md             # regenerate catalog-facing SKILL.md files
bun run check:skill-md             # generated SKILL.md freshness (CI)
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
| `scripts/build-skill-md.ts` | Generated `SKILL.md` renderer + `--check` |
| `scripts/sync-ai-toolbox-skills.ts` | SHA-pinned ai-toolbox vendor sync + network-free `--check` |
| `scripts/check-skill-sources.ts` | Invariant enforcement |
| `src/be/seed/runner.ts` | Generic pristine-vs-user-modified harness |
| `src/utils/skill-fs-writer.ts` | Writes to all five harness trees; owns `.swarm-managed` reconcile |
| `src/utils/skills-refresh.ts` | Worker-side live refresh (mid-session, no restart) |
| `docker-entrypoint.sh` | Legacy boot sync for simple skills into three trees; the runner owns authoritative five-tree refresh |
