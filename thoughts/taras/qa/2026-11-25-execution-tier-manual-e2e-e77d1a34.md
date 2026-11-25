# Execution-tier Manual E2E

Frozen source: `5352fdd087`. Result: **PASS**.

Run date: 2026-11-25 BCN. PostgreSQL: existing container `exec-tier-fast-pg-t9b5`, port 32768.

This walkthrough uses the documented public operations. All credentials and rows are synthetic.
No source code changed. API processes use `bun --no-env-file --no-orphans run src/http.ts`.
Runner processes use the source CLI with two slots and `--allow-shared-uid`.
The API health allowance was 180 seconds. Acceptance thresholds remained unchanged.

## Step results

### Step 1

PASS. Created exec_tier_manual_e77d1a34 on existing PostgreSQL port 32768. Source API health returned 200 on ephemeral port 60972 after 18367ms.

### Step 2

PASS. POST /api/agents returned 201 and UUID 6bbe4309-41bc-4d84-85da-6cfa40fd56aa.

### Step 3

PASS. Inline result was 42 with exitCode 0. GET /api/script-runners returned zero sessions.

### Step 4

PASS. Mint returned 201. Two source CLI runners connected with two slots each. Synthetic token remained in a mode-0600 task file.

### Step 5

PASS. Remote sync returned 42 and incremented runner completions once. Queue metrics: {"sync":{"queued":0,"oldestWaitMs":0,"inFlight":0,"slots":null},"long":{"queued":0,"oldestWaitMs":0,"inFlight":0}}.

### Step 6

PASS. POST /api/script-runs returned 201. Killed owning CLI runner with SIGKILL. Replacement completed after 89098ms. Two distinct guests produced [41,1], two journal rows and one counted effect.

### Step 7

PASS. Stored script and workflow through public routes. Documented trigger body completed eight one-second bodies in 2660ms. Peak overlap was 4 with four advertised slots and embedded slots 0.

### Step 8

PASS. Sent SIGTERM during four held bodies and four queued bodies. Downtime was 2805ms. Two runner sessions returned 236ms after health. Original four guest PIDs survived. GET /api/workflow-runs returned completed with eight results and no repeated item.

### Step 9

PASS. Source API booted on SQLite only, port 64237. Mint returned 409 script_runners_need_postgres.

### Step 10

PASS. Stopped task API and runners. Dropped only the task database. Verified database absence. Removed task payloads, credentials, logs and SQLite files.

## HTTP operations

| Step | Method | Path | Status |
| --- | --- | --- | --- |
| 2 | POST | /api/agents | 201 |
| 3 | POST | /api/scripts/run | 200 |
| 3 | GET | /api/script-runners | 200 |
| 4 | POST | /api/script-runners/credentials | 201 |
| 4 | GET | /api/script-runners | 200 |
| 5 | GET | /api/script-runners | 200 |
| 5 | POST | /api/scripts/run | 200 |
| 6 | POST | /api/script-runs | 201 |
| 6 | GET | /api/script-runs/8bc1edb0-d7dd-48e6-be48-b3339ea37453 | 200 |
| 6 | GET | /api/script-runners | 200 |
| 7 | GET | /api/script-runners | 200 |
| 7 | POST | /api/agents | 201 |
| 7 | POST | /api/scripts/upsert | 200 |
| 7 | POST | /api/workflows | 201 |
| 7 | POST | /api/workflows/c096fe60-333a-468a-a1f2-d46446189b58/trigger | 201 |
| 7 | GET | /api/workflow-runs/774f24ce-7d4b-40f3-98af-844889b91708 | 200 |
| 8 | POST | /api/workflows/c096fe60-333a-468a-a1f2-d46446189b58/trigger | 201 |
| 8 | GET | /api/script-runners | 200 |
| 8 | GET | /api/workflow-runs/52174642-6ce6-4dfe-8925-c0234644ef46 | 200 |
| 9 | POST | /api/script-runners/credentials | 409 |

## Payloads and substitutions

The task used a unique database, ephemeral API ports and a private token file.
The durable JSON source calls one counted journal effect, waits at a local gate, then returns the second result.
The stored native script records each item and PID, waits at a local gate, then waits one second.
A stored normalizer reads `trigger.input.items` and converts numeric values into objects with string IDs.
The foreach reads `normalize.result` and invokes the stored body script for each object.
Both triggers used `{"input":{"items":[1,2,3,4,5,6,7,8]}}`.
The durable run and stored workflow used POST routes instead of pre-existing literal payload files.

The first successful combined restart proof remains separate evidence. This walkthrough restarts an active foreach run.

The first walkthrough stopped at step 7 because the stored script referenced `process.pid`, which the public SDK type checker excludes.
The corrected fixture reads `(globalThis as any).process.pid`.
The first walkthrough cleaned its database and processes before this successful repeat.
No product source changed for this correction.

Final walkthrough failure: none.

## Executed process commands

The harness issued HTTP operations with `fetch`, using the operator bearer and the registered agent header where required.
The table above records each distinct operation and its returned status.
The following commands show the actual process arguments. Secret values are omitted because the task deleted them.

```bash
docker exec exec-tier-fast-pg-t9b5 psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At \
  -c "CREATE DATABASE exec_tier_manual_e77d1a34 TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'"

# PostgreSQL API, with NODE_ENV=test and disabled integrations.
PORT=60972 DATABASE_URL=postgres://postgres:postgres@127.0.0.1:32768/exec_tier_manual_e77d1a34 \
  DATABASE_PATH=/tmp/exec-tier-manual-e77d1a34/postgres.sqlite \
  bun --no-env-file --no-orphans run src/http.ts

# Two concurrent source CLI processes used this command.
SCRIPT_RUNNER_TOKEN_FILE=/tmp/exec-tier-manual-e77d1a34/runner-token SCRIPT_RUNNER_SLOTS=2 \
  bun --no-env-file run src/cli.tsx script-runner --api-url http://127.0.0.1:60972 --allow-shared-uid

# Step 6 sent SIGKILL to the runner whose session reported the durable job in flight.
# A replacement process restored the two-runner fixture after takeover.
# Steps 7 and 8 restarted the API with SCRIPT_EMBEDDED_RUNNER_SLOTS=0.
# Step 8 sent SIGTERM to the API while four item bodies waited at the local gate.

# SQLite API, with DATABASE_URL absent.
PORT=64237 DATABASE_PATH=/tmp/exec-tier-manual-e77d1a34/sqlite.sqlite \
  bun --no-env-file --no-orphans run src/http.ts

docker exec exec-tier-fast-pg-t9b5 psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At \
  -c "DROP DATABASE exec_tier_manual_e77d1a34 WITH (FORCE)"
docker exec exec-tier-fast-pg-t9b5 psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At \
  -c "SELECT datname FROM pg_database WHERE datname='exec_tier_manual_e77d1a34'"
# The final SELECT returned no rows.
```

## Public payload inputs

The register body was `{"name":"manual-e77d1a34","role":"worker","status":"online"}`.
The embedded and remote sync bodies were both `{"source":"export default async () => 42"}`.
The credential body used name `manual-e77d1a34` and an expiry one hour after creation.
The mint returned a synthetic token. The task wrote that token to the private file and never printed it.

The durable payload used this source, with `args.gate` set to the task-owned loopback server:

```typescript
export default async (args: any, ctx: any) => {
  await fetch(args.gate + "/durable-start", {
    method: "POST", body: String(process.pid),
  });
  const first = await ctx.step.swarmScript("effect", {
    source: `export default async (args: any) => {
      await fetch(args.gate + "/effect", { method: "POST" });
      return 41;
    }`,
    args: { gate: args.gate },
  });
  while (!(await (await fetch(args.gate + "/durable-gate")).json()).released)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const second = await ctx.step.swarmScript("after", { source: "export default () => 1" });
  return [first.result, second.result];
};
```

Two successful `POST /api/scripts/upsert` operations stored global native scripts:

```typescript
// manual-normalize-e77d1a34
export default async (args: any) => args.items.map((id: number) => ({ id: String(id) }));

// manual-fanout-e77d1a34
export default async (args: any) => {
  const start = Date.now();
  const pid = (globalThis as any).process.pid;
  await fetch(args.gate + "/workflow-start", {
    method: "POST", body: JSON.stringify({ id: args.id, pid }),
  });
  while (!(await (await fetch(args.gate + "/workflow-gate")).json() as any).released)
    await new Promise((resolve) => setTimeout(resolve, 25));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { id: args.id, pid, start, end: Date.now() };
};
```

`POST /api/workflows` stored this definition. `TASK_GATE_URL` represents the task-owned ephemeral loopback origin.

```json
{
  "name": "manual-fanout-e77d1a34",
  "definition": {
    "nodes": [
      {
        "id": "normalize", "type": "swarm-script",
        "inputs": { "items": "trigger.input.items" },
        "config": {
          "scriptName": "manual-normalize-e77d1a34", "scope": "global",
          "args": { "items": "{{items}}" }
        },
        "next": "fan"
      },
      {
        "id": "fan", "type": "foreach",
        "inputs": { "items": "normalize.result" },
        "config": {
          "over": "{{items}}", "itemKey": "id",
          "body": {
            "type": "swarm-script",
            "config": {
              "scriptName": "manual-fanout-e77d1a34", "scope": "global", "timeoutMs": 120000,
              "args": { "id": "{{item.id}}", "gate": "TASK_GATE_URL" }
            }
          }
        }
      }
    ]
  }
}
```

The first trigger ran with the local workflow gate open.
The second trigger held the first four bodies at that gate until the restarted API returned healthy.
The task then opened the gate and verified completion of all eight items without duplicate starts.
