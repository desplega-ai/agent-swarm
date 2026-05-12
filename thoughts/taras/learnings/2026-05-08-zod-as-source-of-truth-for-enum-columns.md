---
date: 2026-05-08
topic: "Zod as the single source of truth for SQLite enum columns"
type: pattern
tags: [zod, sqlite, migrations, enum, validation]
captured-during: thoughts/taras/plans/2026-05-08-ui-chat-session-experience.md
---

# Zod-as-source-of-truth for enum columns

## Lesson

When a column has a small, evolving enum, **don't** duplicate the values across (a) a SQL `CHECK(col IN (...))` constraint and (b) a Zod schema in `src/types.ts`. The constraint and the schema drift over time. In the agent-swarm codebase, `agent_tasks.source` lived as both:
- `CHECK(source IN ('mcp','slack','api','github','gitlab','agentmail','system','schedule','workflow','linear','jira'))` — table-rebuilt across migrations 001 → 004 → 009 → 043 every time we added a value.
- `AgentTaskSourceSchema = z.enum([...])` in `src/types.ts:56-69`.

But the `POST /api/tasks` route schema was just `source: z.string().optional()` — neither the SQL CHECK nor the Zod enum was actually gating the HTTP layer. The CHECK was the only gate, and it required a table-rebuild to extend.

## Fix pattern

1. Drop the SQL CHECK in a forward-only migration (table-rebuild that mirrors the latest schema *minus* the `CHECK(... IN (...))` line; preserve every other column, default, index, FK, trigger).
2. Tighten the route schema to use the Zod enum: `source: AgentTaskSourceSchema.optional()`.
3. Future enum additions = one-line `src/types.ts` edit. No migration. No table rebuild.

## When to apply

- Any small, evolving string enum on a SQLite column (status fields, source/origin tags, type discriminators).
- New columns being added: prefer **no SQL CHECK from the start** if the column is reachable only via HTTP. Document with a comment in the migration: `-- enforced via Zod (XSchema), not SQL CHECK`.

## When NOT to apply

- Columns written by direct SQL or migrations (where Zod isn't on the path): keep the CHECK.
- Columns where the enum is closed and unlikely to change (e.g., `boolean`-as-text).

## Risks

- Direct SQL inserts (e.g., from migrations or operator scripts) bypass Zod. Document this in the migration so reviewers know the contract.
- The `src/types.ts` schema becomes load-bearing. CI must catch drift — covered by `bun run tsc:check` + tests that exercise the route.

## Source

`thoughts/taras/research/2026-05-08-ui-chat-session-experience-research.md` — full audit. Plan Phase 1 in `thoughts/taras/plans/2026-05-08-ui-chat-session-experience.md` is the first application of this pattern in the codebase; if it goes well, reapply to `agent_tasks.status` next.
