# Real session shapes (prod, read-only, 2026-10-21)

Content-free numbers from the production swarm (`sqlite3 -readonly`), used to make the demo data as complex as real sessions. No ids, text, or names are copied.

## Size of sessions started by people (last 30 days)

| Source | Sessions | 1 task | 2 to 5 | 6 to 20 | over 20 | Largest |
|---|---|---|---|---|---|---|
| Slack | 456 | 69 | 155 | 171 | 61 | 102 tasks |
| Dashboard (`ui`) | 87 | 23 | 44 | 17 | 3 | 28 tasks |

## Four large multi-person sessions

| Tasks | Max depth | People (tasks each) | Lead share | Workers | Sources | Notable task types | Span |
|---|---|---|---|---|---|---|---|
| 85 | 25 | 2 (69, 16) | 57 of 85 | 4 | slack 19, mcp 29, schedule 15, system 22 | follow-up 21, deferred 15, script-run-step 9, research 7, bug 7 | 2.3 days |
| 40 | 11 | 2 (31, 9) | 24 of 40 | 3 | slack 11, mcp 16, system 11, schedule 2 | follow-up 12, implementation 4, review 2, review-fix 2; 6 failed | 3.3 hours |
| 30 | 17 | 2 (28, 2) | 22 of 30 | 3 | slack 11, mcp 9, system 7, schedule 3 | follow-up 7, deferred 3, resume 1 | 1.1 days |
| 30 | 12 | 2 (29, 1) | 18 of 30 | 1 | github 6, mcp 13, system 11 | github-review 6, follow-up 16, feature 5; 3 failed | 15 hours |

## The pattern inside one 40-task Slack session

- Two people take turns in the same thread. Every human message becomes a lead task (`slack`), and its input carries a `<thread_context>` snapshot (9 of 40 tasks).
- The lead delegates through MCP (`mcp`): research, content, review, implementation, review-fix. It often runs 2 or 3 workers in parallel.
- Each worker completion wakes the lead with a `system` `follow-up` (11 of 40). These are internal handoffs.
- One implementation task failed 3 times before it completed. A review-fix failed once and then completed.
- `schedule` `deferred` tasks are the lead waking itself up later. One task was `superseded`, and one was a `resume`.
- Task inputs are long (median about 1,900 characters, up to 8,600). Outputs are short (median about 250 characters, up to 2,200).
