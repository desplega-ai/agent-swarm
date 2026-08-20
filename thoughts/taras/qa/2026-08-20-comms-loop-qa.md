---
date: 2026-08-20T09:00:00Z
topic: "QA report: comms preference loop (UI editor + merge-safe write path + prompt hints)"
author: taras
tags: [qa, prompts, requester-profile, ui, people]
status: complete
last_updated: 2026-08-20
last_updated_by: taras
---

# QA report: comms preference loop

Branch: `worktree-agent-comms-style` (PR #1197, second commit). Builds on the communication-style block shipped in the first commit.

## Scope

1. Merge-safe `comms` write path: PATCH /api/users/{id} + manage-user tool (Sonnet agent; Codex terra was blocked by a 401 CLI auth failure and the slice was rerouted).
2. People detail page "Communication preferences" editor (Opus agent + orchestrator polish pass).
3. Prompt hints: lead template manage-user bullet + task.requester.profile persist line (orchestrator).

## Verdict: PASS

## Gates

| Check | Result |
|---|---|
| `bun run lint` | PASS (1 pre-existing warning) |
| `bun run tsc:check` | PASS |
| `bun run test:root -- http-users, mcp-tools-user, prompt-template-session, runner-requester-profile, requester-comms` | 98 pass, 0 fail (plus 5 new backend tests, 54 pass in the two user suites) |
| `cd apps/ui && bun run lint && bunx tsc -b` | PASS |
| `bun run docs:openapi` | Regenerated (PATCH body gained `comms`) |

## Live API evidence (scratch DB, real server)

```
PATCH {comms:{tone,language,verbosity}} -> {"keepMe":"yes","comms":{"tone":"casual","language":"uk","verbosity":"terse"}}
PATCH {comms:null}                      -> {"keepMe":"yes"}
PATCH {metadata:{fresh:1},comms:{...}}  -> {"fresh":1,"comms":{"tone":"direct"}}
```

Sibling metadata keys survive every comms write. `comms: null` removes only the comms key.

## Browser QA (agent-browser, UI on Vite dev server)

Screenshots in `thoughts/taras/qa/screenshots/`:

- `01-comms-before.png` — section with seeded tone "formal" (Language/Verbosity show placeholders, confirmed empty via a11y snapshot)
- `02-comms-saved.png` — casual / Ukrainian / terse saved, "Profile saved" toast
- `03-comms-persisted.png` — values persist across a full page reload
- `04-profile-card.png` — full profile card after the polish pass (divider + uppercase group label)

Save-button dirty tracking, Discard, and toast all behave correctly. Server-side check after the UI save: `{"source":"qa-seed","keepMe":true,"comms":{"tone":"casual","language":"Ukrainian","verbosity":"terse"}}` — the UI PATCH did not clobber sibling keys.

Polish applied after review: section divider (`border-t`), heading restyled from card-title weight to the form's uppercase muted label style. The 3-column layout for the three short fields was judged intentional and kept.

## Not covered

- Clearing a single field to empty while others stay set (unit tests cover the trim/drop logic; not re-verified in the browser).
- Long-value overflow and non-Latin input rendering.

## Environment notes

- Codex CLI is broken on this machine: 401 Unauthorized from api.openai.com on both attempts (gpt-5.6-terra). Needs `codex login`.
- QA stack: API on scratch DB `/tmp/qa-comms-db.sqlite` (port 3013), Vite dev server on 4637 (5274 was configured but Vite picked 4637). Both shut down after QA.
