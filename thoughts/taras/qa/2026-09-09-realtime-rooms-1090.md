# Issue 1090: implementation and local QA

Date: 2026-09-09
Branch: `codex/realtime-rooms-1090`
Issue: https://github.com/desplega-ai/agent-swarm/issues/1090

## Result

Implemented the settled Yjs design from PR #1104.
Pages, agents, scripts, and workflows can share named rooms through the existing API listener.
The implementation separates versioned page content from shared runtime state.

- Signed page sessions preserve user identity. Operator and password sessions use guest identity.
- One WebSocket multiplexes rooms and transient channels on the same API origin.
- Yjs documents use one debounced KV snapshot per room. Presence stays ephemeral.
- Browser, REST, MCP, and script interfaces support room reads, changes, resets, and decoding.
- Shared events resume workflow wait nodes. Stored scripts can change rooms inside workflows.
- Schema mismatches reject writes. Resets reject previous document generations.
- Namespace authorization, room limits, request limits, and lifecycle checks protect the server.
- The page details view inspects saved room state without creating or changing rooms.

The current dashboard has no generic KV browser. The page details inspector provides the requested snapshot inspection function.

## Automated verification

| Check | Result | Evidence |
| --- | --- | --- |
| Complete root suite | 8,500 passed, 12 skipped, zero failures | /private/tmp/1090-root-final.log |
| Complete API E2E suite | 12 passed, zero skips or failures | /private/tmp/1090-e2e-final.log |
| Complete UI E2E suite, fresh build | 46 passed, 17 skipped, zero failures | /private/tmp/1090-ui-final.log |
| Seeded example after CSS correction | 10 passed, zero failures | /private/tmp/1090-skill-final.log |
| Root, UI, and browser typechecks | Passed | /private/tmp/1090-final-tsc.log |
| Root and UI lint | Passed | /private/tmp/1090-final-lint.log |
| Script SDK type freshness | Passed after staging generated output | /private/tmp/1090-script-freshness-final.log |
| Browser module and OpenAPI freshness | Passed | /private/tmp/1090-final-realtime-browser.log |
| Skill source, generated skill, and bundled file checks | Passed | Final local command output |
| DB, API key, async DB, and promise boundaries | Passed | /private/tmp/1090-final-floating-promises.log |
| RBAC, response schemas, Bun pins, audit columns, test spawn guard | Passed | /private/tmp/1090-final-rbac-coverage.log |
| Dependency graph | Zero errors, 16 existing warnings | /private/tmp/1090-final-dep-graph.log |
| Dependency deduplication and SDK tool registration | Passed | /private/tmp/1090-final-dedupe.log |
| Docker API, worker-slim, and evals builds | Passed | /private/tmp/1090-docker-final-api.log |
| Compiled API container restart | Health, browser module, WebSocket changes, and saved state passed | /private/tmp/1090-docker-runtime.log |

The 12 root skips and 17 UI skips belong to existing test definitions.
The black-box runner measures its registered scenarios. Its route inventory is not complete endpoint coverage.
Focused tests also exercise real room HTTP handlers, MCP registration, and the nested script interface.

Root tests ran without inherited provider API keys. Ambient provider credentials changed unrelated workflow test behavior during an earlier run.
The type generator logged a temporary pricing-refresh warning after deleting its scratch database. Generated types remained stable.
Diff whitespace checks pass for authored files. The generated browser bundle retains whitespace inside dependency template strings.

### Commands

Run these commands from the repository root:

```bash
env -u ANTHROPIC_API_KEY -u OPENROUTER_API_KEY -u OPENAI_API_KEY TMPDIR=/private/tmp bun run test:root -- --parallel=4
TMPDIR=/private/tmp bun run e2e -- --json /private/tmp/1090-e2e-final.json --summary-md /private/tmp/1090-e2e-final.md
TMPDIR=/private/tmp bun run e2e:ui
bun run lint
bun run tsc:check
bun run check:realtime-browser
bun run check:script-types
bun run check:skill-sources
bun run check:skill-md
bun run check:seed-skill-files
bun scripts/check-floating-promises.ts
bun scripts/check-promise-sinks.ts
bash scripts/check-async-db-seam.sh
docker build -f Dockerfile -t agent-swarm-1090-api:local .
docker build -f Dockerfile.worker --target worker-slim -t agent-swarm-1090-worker:local .
docker build -f apps/evals/Dockerfile -t agent-swarm-1090-evals:local .
```

Run UI checks from `apps/ui`:

```bash
bun run lint
bunx tsc -b
```

## Manual browser acceptance

A fresh agent authored `templates/skills/pages/files/examples/multiplayer-board.html` using the pages skill alone.
The example uses `lobby` and `match-42`, persistent cards, ephemeral cursors, agent notes, and visible schema errors.
Browser QA found one theme compatibility defect. Explicit body styles corrected contrast against the injected page theme.
The pages skill now documents that requirement.

Verified with isolated agent-browser sessions and a real local API:

1. A signed user appeared as Taras QA. A separate anonymous browser received a guest handle.
2. The signed viewer created a card. The guest completed it. Both browsers displayed the same state.
3. Both browsers shared lobby text and cursor presence.
4. A bearer-authenticated agent joined the room and changed the visible agent note.
5. Updating the page body preserved both room documents.
6. The dashboard inspector decoded the saved document and displayed its schema version.
7. An edit during browser offline emulation stayed local. After connectivity returned, both browsers displayed the edit and retained their identities.

Offline verification checked `navigator.onLine` and visible divergence, then convergence.
It does not establish whether browser offline emulation closed the existing WebSocket.
Detailed evidence: `/private/tmp/1090-browser-reconnect.md`.

The automated browser test also verifies rejected optimistic writes, subsequent successful changes, stale schemas, and opening the reset schema.
The API scenario verifies MCP-to-browser updates, workflow event delivery, nested script methods, and persistence across an API restart.
Transport tests verify page deletion, generation rejection, origin checks, room isolation, and presence cleanup.

The compiled API image also served the browser module and accepted a WebSocket room change.
Restarting the same container preserved the room state. The check refreshed Docker's dynamically assigned host port after restart.
The container and browser QA servers were removed or stopped after verification.

### Browser evidence

Signed URLs expire after seven days. The agent-fs paths remain available for renewing those URLs.

![Signed viewer with shared state and cursor presence](https://fly.storage.tigris.dev/agent-fs-taras-storage/648a5f3c-35c8-4f11-8673-b89de52cd6bd/drives/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/qa/agent-swarm/2026-09-09-realtime-rooms/viewer.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=tid_HmeSWgYTsPMlIrxsHowzHXHDjaeoDuEISZtTlyZVAXApPgFSNu%2F20260909%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260909T135917Z&X-Amz-Expires=604800&X-Amz-Signature=86cfe1258ec02b97e0c9d72f9287d0ace06ad72dd12a56e1e78d4090bbb7ab0c&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27viewer.png&response-content-type=image%2Fpng&x-amz-checksum-mode=ENABLED&x-id=GetObject)

![Guest replica with matching shared state](https://fly.storage.tigris.dev/agent-fs-taras-storage/648a5f3c-35c8-4f11-8673-b89de52cd6bd/drives/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/qa/agent-swarm/2026-09-09-realtime-rooms/guest.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=tid_HmeSWgYTsPMlIrxsHowzHXHDjaeoDuEISZtTlyZVAXApPgFSNu%2F20260909%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260909T135948Z&X-Amz-Expires=604800&X-Amz-Signature=8809515f70600f4c1abe58b972fffa0430c68065ce1bb586fa5913e52c8d6397&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27guest.png&response-content-type=image%2Fpng&x-amz-checksum-mode=ENABLED&x-id=GetObject)

![Dashboard saved room inspector](https://fly.storage.tigris.dev/agent-fs-taras-storage/648a5f3c-35c8-4f11-8673-b89de52cd6bd/drives/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/qa/agent-swarm/2026-09-09-realtime-rooms/inspector.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=tid_HmeSWgYTsPMlIrxsHowzHXHDjaeoDuEISZtTlyZVAXApPgFSNu%2F20260909%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260909T135952Z&X-Amz-Expires=604800&X-Amz-Signature=a2055d85039a9d466cf0102fb5f2cee85116a77e1b4672471d5a0ab64f51539d&X-Amz-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27inspector.png&response-content-type=image%2Fpng&x-amz-checksum-mode=ENABLED&x-id=GetObject)

Agent-fs directory: `qa/agent-swarm/2026-09-09-realtime-rooms/`.

## Independent review

### Spec axis

All five findings were fixed and tested:

- Expose the documented nested script interface.
- Keep room reads from creating unauthorized rooms.
- Preserve keyed item identity during concurrent array changes.
- Reject scalar document roots.
- Reject asynchronous mutation callbacks explicitly.

### Standards axis

Ten findings were fixed:

- Bound streamed request bodies before decoding.
- Reserve connection slots during asynchronous authentication.
- Distinguish pending reads from pending room creation.
- Recheck activity after an idle flush.
- Recover the browser write queue after an optimistic rejection.
- Retain the Yjs client identity across operation batches.
- Drain accepted HTTP requests before flushing rooms during shutdown.
- Use a read-only transaction for room loading.
- Declare operation types as a discriminated union.
- Require successful workflow completion through the expected branch.

One finding was rejected. The issue's settled design explicitly uses `WebSocketServer({noServer:true})` on the existing HTTP listener.
Bun supplies its built-in `ws` compatibility implementation.
See the transport findings in `thoughts/taras/research/2026-08-04-realtime-collab-primitive-open-questions.md`.
This follows the task-specific transport design while preserving the API listener and CSP.

## Operational limits

Run one API replica. Shared rooms do not coordinate across replicas.
Snapshot durability is best effort, with a one-second debounce. A crash can lose recent unflushed changes.
Moving keyed array items deletes and reinserts those items. Concurrent edits to a moved item can be lost.
Room documents must not contain secrets. CRDT transport and snapshots preserve document values without secret scrubbing.

Signed browser upgrade tests pass with synchronous HMAC computation.
A minimal deferred-crypto probe did not reproduce the earlier socket failure. Its exact cause remains unisolated.
