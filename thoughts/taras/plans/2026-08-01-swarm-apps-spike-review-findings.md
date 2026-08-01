# Review findings on the server slice — fix round 1

Two-lens review (Opus core + Sonnet periphery) of your working-tree server slice. Periphery: clean.
Core: 11 findings, dispositions below. Fix every item marked FIX. F6 is ACCEPTED (no action).

F1. FIX — src/apps/row-store.ts:71: `validValue()` rejects `null` on every column; spec only
requires rejecting null on REQUIRED columns. Make `null` legal on optional columns: PATCH with
`{"values":{"notes":null}}` clears the column (remove the key from the stored row, and remove its
index entry if the column is indexed). Null on a required column stays a 400 issue.

F2. FIX — src/http/apps.ts:283: `parseFilterValue()` uses bare `Number(raw)` for number columns —
accepts "", whitespace, hex ("0x10"). Use a strict decimal regex (optional sign, digits, optional
fraction; reject empty/NaN/Infinity) and return 400 `{error, issues}` on mismatch.

F3. FIX — src/apps/definition.ts:80 + validation: `AppQueryDef.filter` values are only checked for
column existence, not kind. Validate at definition time that each filter value's JS type matches
the column kind (string→string, number→number, boolean→boolean, enum→string AND a member of the
enum, date→string ISO-parseable). Mismatch → definition issue (agent retry contract), since
`applyQuery` compares with strict `===` and silently returns [] today.

F4. FIX — src/http/apps.ts:373,401,421,555: no body-size caps. Mirror src/http/pages.ts:379
(`enforceContentLengthCap`, 5 MB) on POST/PUT /api/apps and all row-mutation routes (single 1 MB,
bulk 10 MB — pick constants, name them like pages does).

F5. FIX — src/apps/row-store.ts:271-273 + src/http/apps.ts:592-594: app delete removes the `apps`
row BEFORE purging the KV namespace, so a mid-purge crash orphans unreachable KV data. Reorder:
purge namespace first, delete the apps row last (a partial purge then leaves the app retriable
instead of orphaned).

F6. ACCEPTED — the edits to run-bun-tests.test.ts / tracker-fold.test.ts / rbac-engine.test.ts
stay as-is (verified genuine isolation fixes, additive). No action.

F7. FIX — src/apps/definition.ts:149: `appDefinitionIssues()` drops the real message for zod v4
`invalid_key` errors (record key regex failures) — agent sees generic "Invalid key in record".
Flatten nested `issue.issues[]` so the actual rule text ("must start with a lowercase letter…")
reaches the issues array. Applies to model/column/query name failures.

F8. FIX — src/http/apps.ts:331-332: `compareValues()` puts null/undefined "greater" and sort sites
negate the whole result for desc → missing values land FIRST in desc. Make missing values sort
LAST regardless of direction (handle null/undefined outside the negated comparison).

F9. FIX — src/apps/row-store.ts:245: `deleteAppRow()` finds index entries by scanning
`${model}/idx/` with limit 100000 + suffix match — silently truncates past 100k entries and does a
full scan even for models with no indexed columns. Instead recompute the row's exact index keys
from the definition + the row's current values (same logic the write path uses) and delete those
keys directly. No scan.

F10. FIX — src/http/apps.ts:573-578: PUT doesn't re-check `updateApp()`'s return; concurrent
delete → `200 {"app": null}`. Return 404 when updateApp yields null.

F11. FIX — src/apps/row-store.ts:155-160: `createdAt` has no monotonic bump (patch path has one at
:226). Apply the same `Math.max(Date.now(), lastIssuedMs + 1)` pattern to creates (per-model or
per-store monotonic counter) so same-millisecond creates keep insertion order under
`sort: createdAt`.

## New/extended tests required in src/tests/apps-spike.test.ts
- PATCH null clears an optional column (value gone from row + its idx key gone); null on required → 400.
- `?filter.votes=` (empty) → 400; `?filter.votes=0x10` → 400.
- app definition with query filter kind mismatch (votes: "3") → 400 with a precise issue path.
- PUT on a just-deleted app → 404.
- Same-millisecond burst creates preserve creation order under createdAt sort.
- Row delete removes exactly its computed index keys (create rows with 2 indexed columns, delete one row, count remaining idx keys precisely).
- Column-name regex violation error message contains the actual rule, not "Invalid key in record".

## Verification (all must pass before you report)
bun run lint
bun run tsc:check
bun run test:root -- src/tests/apps-spike.test.ts
bun run test:root
bun run check:rbac-coverage
bun run docs:openapi

Same fences as the original task: src/** only, do NOT touch apps/ui/**, do NOT git commit/add.
Report: status, per-finding disposition, files changed, condensed verification output.
