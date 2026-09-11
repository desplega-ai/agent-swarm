# ACP persisted log regression fixture

`acp-beea63b7.json` contains 30 rows derived from a real persisted ACP transcript,
then sanitized for this public repository. Row/task/session/agent and provider
message/tool identifiers are deterministic examples; timestamps are synthetic.
Internal paths, business prose, agent instructions, command descriptions and model
catalog entries have been replaced with neutral synthetic payloads.

The real record envelopes, event order, nested object/array shapes, raw/normalized
message and thought twins, bash and todowrite update/progress/result sequences,
and usage/result metadata remain intact. Catalog previews retain truncated JSON
and their original length class. This preserves the provider-emitted regression
cases without retaining the source transcript's operational content. Identical
source strings and identifiers map consistently so deduplication and pairing are
still exercised. The filename is a historical label, not a live task reference.

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
