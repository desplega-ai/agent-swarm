# ACP persisted log regression fixture

`acp-beea63b7.json` contains 30 unmodified `session_logs` rows from task
`beea63b7-04ee-485e-a09f-335afa5ddcef`, fetched on 2026-09-11. It includes the
truncated session-init model catalog, raw/normalized message and thought twins,
bash and todowrite calls with their updates/progress/results, and usage/result
metadata. Row IDs, timestamps and content are retained for provenance.

Run from the repository root:

```sh
bun test apps/ui/tests/acp-logs-parser.test.ts
```

The test exercises both dashboard and evals ACP adapters. Evals has its own parser
copy and has diverged in other providers; only the ACP implementation is kept in
sync by this change.

The complete 5,257-row transcript was also replayed through both versions of the
dashboard parser and the updated local `SessionLogViewer`:

| Block | Before | After |
| --- | ---: | ---: |
| text | 10 | 10 |
| thinking | 29 | 29 |
| tool_use | 50 | 50 |
| tool_result | 50 | 50 |
| provider_meta:lifecycle | 163 | 0 |
| provider_meta:unknown | 1 | 0 |
| provider_meta:internal | 0 | 1 |
| provider_meta:helper | 1 | 1 |
| provider_meta:result | 1 | 1 |

All 50 calls remain paired. The 10 text blocks include two stderr notices.
The compact session-init marker replaces the model-catalog dump. Raw source rows
remain available in the normalization result for diagnostics.
