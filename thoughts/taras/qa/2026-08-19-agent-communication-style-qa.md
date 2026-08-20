---
date: 2026-08-20T00:00:00Z
topic: "QA report: agent communication style + requester comms adaptation"
author: taras
tags: [qa, prompts, requester-profile]
status: complete
last_updated: 2026-08-20
last_updated_by: taras
---

# QA report: communication style one-shot

Branch: `worktree-agent-comms-style`. Plan: `thoughts/taras/plans/2026-08-19-agent-communication-style-oneshot.md`.

## Verdict: PASS

## Evidence

| Check | Command | Result |
|---|---|---|
| Typecheck | `bun run tsc:check` | PASS |
| Lint | `bun run lint` | PASS (1 pre-existing warning) |
| Targeted tests | `bun run test:root -- prompt-template-session, runner-requester-profile, requester-comms, base-prompt` | 129 pass, 0 fail |
| Poll tests | `bun run test:root -- multi-runtime-registration` | 131 pass, 0 fail |
| Full suite | `bun run test:root` | 5 fail, 3 errors: ALL pre-existing. Same 5 fail on main (`workflow-executors`, `script-workflows-runtime-e2e`, `workflow-engine-v2` ulimit/sandbox suites, local-env only) |
| DB boundary | `scripts/check-db-boundary.sh` | PASS |
| API-key boundary | `scripts/check-api-key-boundary.sh` | PASS |
| Audit columns | `scripts/check-audit-columns.sh` | PASS (no new tables) |
| Dep graph | `bun run check:dep-graph` | 0 errors (12 pre-existing warnings) |
| OpenAPI drift | `bun run docs:openapi` | Regenerated, committed |

## Rendered-prompt evidence (required by task)

`resolveTemplate` on all 5 composites:

```
system.session.lead          | block: true | mirror: true
system.session.worker        | block: true | mirror: true
system.session.worker.pi     | block: true | mirror: true
system.session.lead.pi       | block: true | mirror: true
system.session.worker.remote | block: true | mirror: true
```

Full `getBasePrompt()` assembly (the real runtime path, runner.ts → base-prompt.ts):

```
lead          | block: true | mirror: true | emdash-rule: true
worker.remote | block: true | mirror: true | emdash-rule: true
```

Requester profile with `users.metadata.comms`:

```
## Requester Profile
This task was requested by Taras (CEO).
Their communication preferences: tone: casual, language: uk, verbosity: terse.
Honor this requester profile in tone, depth, and format where it doesn't conflict with correctness or your operating rules.
```

## Coverage added

- `prompt-template-session.test.ts`: registration count 31 → 32, block asserted in all 5 composites.
- `runner-requester-profile.test.ts`: comms rendering, comms-only gate, empty-comms no-op.
- `requester-comms.test.ts` (new): metadata parsing edge cases (non-object, non-string, empty, trim).

## Notes

- Pool-claim `task_assigned` also gained `requestedBy` (same hole as `task_offered`, same helper). Direct-assign behavior preserved, UNKNOWN sentinel intact.
- Nothing writes `users.metadata.comms` yet; fields render only when set.
