# UI E2E tracker

One ingest point for Playwright UI E2E results and swarm exploratory browser
testing. Results are informational — nothing here gates a merge.

Producers: GitHub Actions (2 shards, PR / main / nightly) and swarm workers that
boot API + UI and explore. Both post the same payload.

## Pieces

| Piece | Where | Identity |
|---|---|---|
| `ui-e2e-ingest` | `src/be/seed-scripts/catalog/ui-e2e-ingest.ts` | global catalog script |
| `ui-e2e-sweep` | `…/ui-e2e-sweep.ts` | global catalog script, cron `*/15 * * * *` |
| `ui-e2e-prune` | `…/ui-e2e-prune.ts` | global catalog script, cron `0 4 * * *` UTC |
| shared core | `…/ui-e2e-core.ts` | text-prepended into all three at seed time |
| payload schema | `schemas/ui-e2e-ingest.v1.schema.json` | published contract |
| app | `uiE2eTracker` | created on first ingest, looked up by name |
| workflows | `ui-e2e-incident-triage`, `ui-e2e-promote-finding` | created on first ingest |
| page | slug `ui-e2e`, `authMode: public` | upsert by (endpoint agent, slug) |

The app, the workflows and the schedules are **created on first ingest**, not
seeded. There is no app or workflow `Seeder` kind in `src/be/seed/registry.ts`,
and both entity types already carry their own version history and rollback — an
idempotent lookup-by-name ensure is far simpler than teaching the seeder harness
pristine-vs-user-modified semantics for them. Resolved ids are cached in KV
namespace `ui-e2e`.

## Calling it

CI (external, bearer):

```bash
curl -sS -X POST "$SWARM_E2E_INGEST_URL" \
  -H "Authorization: Bearer $SWARM_E2E_INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  --data @e2e-report.json
```

`SWARM_E2E_INGEST_URL` is `<MCP_BASE_URL>/api/x/script/<endpointId>`. Create the
endpoint once (lead only — `script.api.create`):

```
script-apis action=create scriptId=<id of ui-e2e-ingest> agentId=<owning agent> label="ui-e2e ingest"
```

The bearer is returned exactly once. The `agentId` you pass owns the app and the
public page, because `src/http/x.ts` runs the script as `endpoint.agentId`
regardless of who posts — which is what keeps the page slug stable across
producers.

A swarm worker does **not** use the bearer:

```
script-run name="ui-e2e-ingest" scope="global" args={ … }
```

Same script, same code path, authenticated as the worker. This is deliberate:
`get-config includeSecrets` returns `MASKED` for every non-lead worker, so a
design that made workers read the bearer would be broken for all of them.

## Identity and dedup

| model | upsert key |
|---|---|
| `runGroups` | `repo#target#sha#runner` |
| `runs` | `<groupKey>#shardIndex` |
| `results` | `<runKey>#specId` |
| `artifacts` | `<runKey>#kind#(path\|url)` |
| `findings` | `<groupKey>#slug(title)` |
| `incidents` | `repo#fingerprint` |

Apps have no composite-unique constraint and `POST /rows` always creates, so
every model carries an indexed `*Key` column and the scripts upsert by filtered
list then PATCH. A retry of the same `(repo, sha, shard, runner)` therefore
lands on the same rows and bumps `runs.attempt` instead of duplicating.

`fingerprint = fnv1a64(specId + "\n" + normalizeError(error))`. Normalization
takes the first line, strips ANSI, and replaces uuids, hex, urls, paths and
**every digit run**. Digit-stripping is the load-bearing part: without it
`Timeout 5000ms exceeded` and `Timeout 30000ms exceeded` are two incidents for
one bug. FNV-1a rather than SHA-256 because the runtime import allowlist rejects
`crypto` and a fingerprint is not a security boundary.

## Aggregation

Shards report independently. Each report upserts its `runs` row, then recomputes
the `runGroups` row from **every** shard row sharing the key — never from the
incoming payload alone. That is what makes out-of-order and retried reports
converge.

- complete = `COUNT(DISTINCT shardIndex) == max(shardTotal)`
- status: `failed` if any shard failed → `passed` if complete and all passed →
  `incomplete` if past `UI_E2E_SHARD_TIMEOUT_MIN` → else `running`.
- Failure beats incompleteness: one failed shard plus one missing shard is a
  failed run. The failure is evidence; the missing shard is only absence.
- `ui-e2e-sweep` is the only writer of `incomplete`. It also materializes a row
  per missing shard so the page shows *which* shard died.

## Incident lifecycle

Only `trigger` in (`main`, `nightly`), and never for a fork payload.

- First failure for a fingerprint → open the incident, fire triage **once**.
- Later failures → `occurrences++`, no second dispatch. One triage task per
  fingerprint.
- Green close: on a **complete** all-passed group, close open incidents for that
  repo whose `specId` is among that group's passed results. Scoped to specs
  actually exercised — closing every open incident for the repo would silently
  close incidents for specs these shards never ran.
- A closed incident that fails again reopens the **same row**, so flake history
  stays in one place.
- PR and manual runs write rows and stop.

## Dispatch cap

`UI_E2E_MAX_PRS_PER_DAY` (default 5), shared by both workflows, enforced with an
atomic `kv_incr` on `ui-e2e:dispatch:<YYYY-MM-DD>` (UTC) before the workflow is
triggered. Atomic because two shards landing together must not both read "4 used".
Over cap, the row is written with `triageStatus: "deferred"` / `status:
"deferred"` and the next sweep requeues it once the counter rolls over. The cap
limits *dispatches*; a dispatched task may still choose not to open a PR.

## Page

Regenerated after each ingest, debounced by `UI_E2E_PAGE_MIN_INTERVAL_SEC`
(default 30) — without it two shards plus a retry rewrite and version-snapshot
the page five times a minute. A status change always wins the debounce.

Artifact links use **agent-fs live viewer URLs**
(`{AGENT_FS_LIVE_URL}/file/~/{orgId}/{driveId}/{path}`, the same form
`buildAgentFsLiveUrl` builds in `src/utils/constants.ts`). They are
path-addressed and unsigned, so there is no expiry and nothing to re-sign on a
regeneration — a link minted today still resolves after any number of rewrites.
GitHub Actions artifact URLs are stored verbatim and labelled as expiring,
because they genuinely do.

## Fork PRs

A `pull_request` run from a fork has no secrets and no agent-fs token. The fork
job uploads GitHub Actions artifacts and ingests nothing. A separate
`workflow_run` job in base-repo context downloads the report and posts it with
`isFork: true`, `runner: "sandbox"`, artifacts as `storage: "github"`.

A fork payload may not write agent-fs paths (rejected by the script, counted in
`forkRejectedArtifacts`), open or close incidents, or spend the dispatch budget.
`trigger: "pr"` already excludes it from incidents; the explicit rejection is
defense in depth so a mislabelled payload cannot reach those paths.

## Untrusted input

Everything a producer sends is untrusted. A fork PR controls its own test
titles and error text, and the tracker hands those fields to an agent that can
open a PR or file a Linear issue, then renders them on a public page. Three
controls, all added in response to the Superagent review of PR #1349:

- **Dispatch is authenticated.** The triage and promote workflows declare **no**
  webhook trigger. A bare `{type:"webhook"}` trigger is an open endpoint —
  `verifyWebhookRequest` returns early when a trigger has neither `hmacSecret`
  nor `verification` — so anyone who learned the workflow id could POST trigger
  data and drive a PR-capable agent, bypassing the ingest bearer and the daily
  cap. Dispatch goes through the authenticated `workflow_trigger` SDK call
  instead, and `handleWebhookTrigger` rejects `/api/webhooks/{id}` for a
  workflow that declares no webhook trigger. `ensureWorkflow` strips a webhook
  trigger left behind by an older deployment.
- **Report fields are data, not instructions.** Values interpolated into
  `TRIAGE_PROMPT` / `PROMOTE_PROMPT` pass through `untrusted()`: the fence
  marker is stripped so the block cannot be closed early, `{{`/`}}` are broken,
  control characters are dropped, and length is capped at 2000 chars. Both
  prompts wrap the data in an `UNTRUSTED_FENCE` block, say it is evidence and
  never instructions, and carry a scope limit telling the agent to stop and
  report an attempted injection. Sanitizing is mitigation, not a guarantee —
  the closed-enum structured output is what the pipeline actually trusts.
- **URLs are scheme-allowlisted.** `safeHttpUrl` accepts only absolute
  `http(s)`. Applied at ingest (`artifacts[].url`, `run.ciUrl`,
  `annotate.fixPr`) so a `javascript:` URL is never stored, and again at render
  for every `href` on the public page so pre-existing rows stay inert. A
  rejected URL renders as text instead of a link. `annotate.linearIssue` is
  exempt: it renders as text, and `DES-123` is a legitimate value.

## Retention

`ui-e2e-prune`, daily 04:00 UTC, `UI_E2E_RETENTION_DAYS` (default 30). Deletes
stale run groups and their runs/results/artifacts; findings only when `promoted`
or `dismissed`; incidents only when `closed`.

**Open incidents are never pruned regardless of age.** An incident open for 40
days is precisely the record you must not lose — deleting it would let the next
failure open a fresh one with `occurrences: 1` and no history.

agent-fs pruning needs `UI_E2E_AGENT_FS_BASE_URL`, `UI_E2E_AGENT_FS_ORG_ID` and
the secret `UI_E2E_AGENT_FS_TOKEN`. When any is missing the script reports the
stale prefixes under `agentFs.stalePrefixes` and still prunes app rows — losing
the row prune because a storage credential is absent would be the worse outcome.

## Config

| Key | Default | Effect |
|---|---|---|
| `UI_E2E_SHARD_TIMEOUT_MIN` | 90 | when a missing shard makes a run `incomplete` |
| `UI_E2E_MAX_PRS_PER_DAY` | 5 | triage + promote dispatches per UTC day |
| `UI_E2E_RETENTION_DAYS` | 30 | retention window |
| `UI_E2E_PAGE_RUNS_PER_TARGET` | 10 | run groups listed per target on the page |
| `UI_E2E_PAGE_MIN_INTERVAL_SEC` | 30 | page regeneration debounce |
| `UI_E2E_AGENT_FS_ORG_ID` / `_DRIVE_ID` | — | viewer-link fallback when a payload omits them |
| `UI_E2E_AGENT_FS_BASE_URL` / `_TOKEN` | — | agent-fs pruning (token is a secret) |

All read at run time, so they are tunable without a redeploy.

## Tests

```bash
bun run test:root -- src/tests/scripts-ui-e2e-tracker.test.ts src/tests/seed-scripts.test.ts
```

The tracker suite covers the pure logic (keys, fingerprint normalization, shard
aggregation including out-of-order, duplicate and disagreeing-`shardTotal`
cases), the app definition against the real `parseAppDefinition` validator, page
escaping, and parity between the published JSON schema and the Zod schema the
endpoint actually validates against.
