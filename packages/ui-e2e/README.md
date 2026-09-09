# ui-e2e

Playwright suite for `apps/ui`. Every Playwright worker gets its own fresh, seeded API. The dashboard is the production build served from `apps/ui/dist`.

Run it from the repo root:

```bash
bun run e2e:ui                                   # build apps/ui, then run everything
bun run e2e:ui -- --no-build --grep @smoke       # routes only, reuse the build
bun run e2e:ui -- --headed specs/pages.spec.ts   # watch one spec
bun run e2e:ui:tsc                               # typecheck both halves
```

The full recipe, the env table, and the CI notes live in [LOCAL_TESTING.md](../../LOCAL_TESTING.md#ui-e2e-bun-run-e2eui).

## Layout

| Path | Runtime | Role |
|---|---|---|
| `boot/run.ts` | Bun | Root entry (`bun run e2e:ui`). Reads the target, builds the UI, spawns the Playwright bin. |
| `boot/sut.ts` | Bun | Per-worker API. Starts the server through `scripts/e2e/sut.ts`, seeds it, writes the manifest, blocks on stdin. |
| `boot/seed.ts` | Bun | API-driven seed plus the `bun:sqlite` escape hatch. Idempotent, every name `e2e-` prefixed. |
| `boot/seed-cli.ts` | Bun | `seed()` as a CLI for remote runs. |
| `boot/policy.ts` | both | Target resolution (`readTarget`) and the production host refusal. No Bun or Node APIs. |
| `boot/manifest.ts` | both | The `SeedManifest` type. |
| `global-setup.ts` | Node | Static server for `apps/ui/dist` on a free port (`E2E_UI_URL`), remote seeding. |
| `fixtures/index.ts` | Node | `swarm`, `seed`, `api`, `clean`, plus the `baseURL` and `storageState` overrides. |
| `specs/` | Node | `home`, the route smoke (`routes.ts` + `smoke.spec.ts`), `tasks`, `configuration`, `pages`. |
| `reporter/summary.ts` | Node | Writes `test-results/summary.json`, including `titlePath` (the describe-block path plus the test's own title) and `attachments` (each attachment's name, contentType, and path). |
| `reporter/comment.ts` | Node | Turns summaries into the sticky PR comment. |
| `reporter/publish-plan.ts` | Node | Turns summaries into the agent-fs upload plan and the comment image pick. |
| `reporter/publish-artifacts.ts` | Node | Uploads screenshots, traces, and summaries to agent-fs, writes `artifacts.json` and `images.json`. |
| `reporter/ingest-payload.ts` | Node | Builds the tracker v1 payload from a shard summary plus `artifacts.json`. |
| `reporter/ingest.ts` | Node | Posts one payload per shard to the tracker endpoint. |
| `reporter/cli.ts` | Node | Shared flag parser. |
| `reporter/ui-e2e-ingest.v1.schema.json` | n/a | Vendored copy of the tracker's frozen v1 schema. The oracle for the payload unit tests. |

Two tsconfigs cover the two runtimes: `tsconfig.json` (Node, `specs`, `fixtures`, `reporter`, `global-setup.ts`) and `tsconfig.boot.json` (Bun, `boot/`). `bun run e2e:ui:tsc` runs both.

## Boot handshake

1. The `swarm` worker fixture spawns `bun boot/sut.ts --sut-env APP_URL=<E2E_UI_URL>`.
2. The child starts the API on a free port with a temp SQLite file, runs the seed, and writes `<db>.seed.json`.
3. The child prints one JSON line: `{ apiUrl, apiKey, dbPath, manifestPath }`. Nothing else goes to stdout.
4. The fixture reads the manifest and serves tests. When the worker ends it closes the child's stdin. EOF, SIGTERM, or SIGINT stop the API and delete the temp files.

`APP_URL` puts the UI origin on the API's CSP `frame-ancestors` list. `HEARTBEAT_DISABLE=true` keeps the backdated in-progress task stalled. `E2E_KEEP=1` keeps the DB, the log, and the manifest.

## Fixtures

| Fixture | Scope | Gives |
|---|---|---|
| `swarm` | worker | `{ apiUrl, apiKey, manifest }`. Remote mode returns the env target and skips the spawn. |
| `seed` | test | The manifest, or `null` in a remote run without `E2E_REMOTE_SEED=1`. Guard with `test.skip(!seed, ...)`. |
| `api` | test | `get`, `post`, `put` against the worker API with the bearer. |
| `clean` | test, auto | Collects console errors and `/api` responses with status 400 or higher. `assertClean()` fails with both lists. |
| `storageState` | test | Pre-writes `agent-swarm-connections` (the active connection), `swarm:v1:<apiUrl>:current-user` (the identity), and a freshly dismissed `swarm:feedback-popup:v1:<apiUrl>:<userId>` so no dialog blocks the dashboard. |

Two console errors are ignored on purpose, each with a comment in `fixtures/index.ts`: the browser SDK's `/@swarm/config` probe inside `/p/:id` (the pages API does not serve that route yet) and, only in remote mode with the static build, the CSP `frame-ancestors` violation for the page preview.

## Seed manifest

```json
{
  "user": { "id": "...", "name": "e2e-user" },
  "agents": { "lead": "...", "workerA": "...", "workerB": "..." },
  "tasks": {
    "pool": ["...", "..."],
    "inProgress": "...", "completed": "...", "failed": "...",
    "pendingLead": "...", "offered": "...", "draft": "..."
  },
  "pages": { "public": { "id": "...", "apiUrl": "..." }, "authed": { "id": "...", "apiUrl": "..." } },
  "session": { "id": "e2e-session-1" },
  "memory": { "name": "e2e memory" }
}
```

The escape hatch backdates the in-progress task by 45 minutes (stalled) and `e2e-worker-b` by one day. Finishing the two worker tasks makes the API create two lead follow-up tasks, so a seeded DB holds ten tasks: the eight seeded rows plus those two.

## Remote mode

| Variable | Effect |
|---|---|
| `E2E_API_URL` | Target API. `api.desplega.agent-swarm.dev` and `cloud.agent-swarm.dev` are refused. |
| `E2E_API_KEY` | Bearer for that API. Required with `E2E_API_URL`. |
| `E2E_UI_URL` | Deployed dashboard to drive. Without it the static build serves the UI. |
| `E2E_REMOTE_SEED=1` | Seed once per run (idempotent). Without it seeded specs and id routes are skipped. |

Specs tagged `@local` run only in local mode. None exist yet; the tag is for assertions on escape-hatch state.

## CI

`.github/workflows/ui-e2e.yml` runs two shards on pull requests that touch the UI, the API, or this package, and on pushes to `main`. It also runs on a nightly cron (`0 3 * * *` UTC) and on manual dispatch.

The `report` job resolves the run context once: trigger, target, sha, ref, and PR number. Every later step reads that context. It merges the blob reports into the `ui-e2e-html-report` artifact. For every same-repo event, it uploads screenshots, traces, and each shard's `summary.json` to agent-fs. It builds the sticky PR comment from every `summary.json`. It ingests one payload per shard into the UI E2E tracker. It uploads the ingest payloads and `artifacts.json` as the `ui-e2e-ingest-payloads` artifact for review.

The workflow is informational and not a required check. Screenshot links need the `E2E_AGENT_FS_*` repository secrets. Without them the comment carries the text table only. Tracker ingest needs `UI_E2E_INGEST_URL` and `UI_E2E_INGEST_BEARER`. Without them ingest is skipped. `merge-gate.yml`'s `ui-lint` job typechecks and lints this package.

## Hooks for the next phases

- P2 is done. `reporter/ingest-payload.ts` builds the tracker v1 payload from `summary.json` and `artifacts.json`. `reporter/ui-e2e-ingest.v1.schema.json` is a verbatim copy of the tracker's frozen v1 contract (`desplega-ai/agent-work`, `workflows/ui-e2e-tracker/schema/`). Do not edit it here.
- The swarm exploratory runner (P3) reuses this payload shape. It adds `runner: swarm-worker`, a `findings` list, and a `cost` block.
- The fixture name `ai` is reserved for `pw.ai` (P4, `DES-782`).
- The swarm exploratory runner (P3) reuses `boot/sut.ts` and the seed inside a worker.
