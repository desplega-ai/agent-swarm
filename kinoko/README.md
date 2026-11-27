# Kinoko workloads for the API

[Kinoko](https://kinoko.sh) runs the containers of a `compose.yaml` in a deterministic
hypervisor, injects faults, and reports each broken check with the steps to it
([docs](https://kinoko.sh/docs.md)). These workloads test what the other suites do not:
timing races in the storage layer under crashes and partitions.

| Workload | Containers | Faults |
|---|---|---|
| `postgres/` | API, PostgreSQL 18 with pgvector, client | API down, database down, API cut from database, API slow (to database, to all), client cut from API |
| `sqlite/` | API on a SQLite file in a volume, client | API down, client cut from API |

There is no LLM and no worker in the guest. The model's two actions play the clients
over HTTP. `work`: one to four workers take a step at the same time (poll and claim,
write progress, finish, fail, or die with a task). `ops`: an operator creates a task
(once, or twice at the same time under one Idempotency-Key), sends an old create
again, cancels a task, or runs a heartbeat sweep. Setup leaves four waiting tasks and
two claimed ones, so every line of the search starts with work in every state.

## Files

- `build.sh`: builds the two images for linux/amd64 and writes both `model.lua` files.
- `images/swarm/`: the API image of one commit plus the client scripts in `/k`.
  - `k/act`: one client step (`work`, `create`, `replay`, `cancel`, `sweep`, and `init` and `seed` for setup). It writes every answer of the API to a journal.
  - `k/audit`: compares the journal with `GET /api/tasks` and prints the numbers the checks read.
  - `k/serve`: starts the API again when it exits (on Postgres it exits when it loses the one-process lock).
- `images/postgres/`: PostgreSQL 18 with pgvector on alpine, without LLVM (105 MB; `pgvector/pgvector:pg18` is about 480 MB).
- `model/common.lua`: setup, resources, actions and checks. `model/postgres.lua` and `model/sqlite.lua`: the faults of each variant.
- `postgres/`, `sqlite/`: the workload directories that `kinoko push` takes. Their `model.lua` is generated: edit `model/*.lua`, then run `./build.sh --models-only`.

## Checks

| Check | Kind | Holds when |
|---|---|---|
| no task is claimed by two agents | always | no task id was handed to two agents by `/api/poll` |
| no task is dispatched twice | always | no agent was handed the same task id twice |
| an agent holds at most one task | always | no agent has two `in_progress` tasks (`maxTasks` is 1) |
| a running task has an agent | always | no `in_progress` task has an empty `agentId` |
| an acknowledged task is readable | always | each task id from a create or a poll answer is in the task list |
| an Idempotency-Key names one task | always | each create key answered with one task id |
| a terminal task stays terminal | always | no task seen terminal is non-terminal later |
| a terminal status does not change | always | no task seen terminal holds another terminal status later |
| crash recovery makes one follow-up per task | always | no task has two child tasks (a resume or a reboot retry) |
| the API comes back after a fault | always | the task list is never unreadable for more than 40 s |
| an API that answers /health serves the task list | always | `/health` is never 200 for more than 20 s while the task list does not read |
| no task stays in_progress without a live agent | always | no `in_progress` task is 20 s without an update while the API reads |
| `work`, `ops`: the answers fit the contract | reply | no answer contradicts an earlier one (see `viol=` in `k/act`) |
| `work`, `ops`: no server error on SQLite | reply | no 5xx answer (SQLite variant only) |

Three `sometimes` goals show that a run reached a claim, a completion and a crash
recovery. Kinoko reports one that no line reached. The heartbeat runs every 2 s and
takes a task with no session after 6 s
(`HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_STALL_NO_SESSION_MIN` in the compose files), so
crash recovery happens inside a run.

## Run

```bash
./kinoko/build.sh                                  # images and model.lua files
kinoko check kinoko/postgres                       # no key needed
kinoko run --local kinoko/postgres                 # free: setup, 10 s of actions, no faults
kinoko push kinoko/postgres --name agent-swarm-postgres --keep
kinoko run agent-swarm-postgres --minutes 15       # costs minutes
kinoko show <run> --log
```

`kinoko run --local` and `kinoko push` write `images.tar` into the workload directory
(`sqlite/` 441 MB, `postgres/` 540 MB). It is ignored by git. Delete it after use.

All commands but `check` need `KINOKO_API_KEY`. Load it in the command that needs it.

To test another commit, set `SWARM_IMAGE` for `build.sh` (see its header) and change
the image tag in both compose files.

## What the harness does (learned from the first runs)

- A setup step must answer within 30 s. The first boot applies every migration, so the
  model waits for the API in several short steps.
- A command of an action stops after 10 s of guest time. Each request of `k/act` stops
  after 4 s, and a step makes at most two requests.
- A fault lasts 25 ms to 5.1 s. `down` is `podman kill` then `podman start`. A
  restarted container can get a new IP address.
- A line of the search lasts about 9 s (median) and at most about 55 s. Recovery
  bounds in the checks are therefore in guest seconds, not minutes.
- "Settled" is a few seconds after the faults stop, not a wait for recovery. The API
  needs about 5 s to start again, so an `eventually` check on the API fails by design.
  The model has none.
- A resource reading that takes a few seconds is dropped (one of 4 s never arrived).
  `k/audit` stops its two requests at 1.2 s. When the audit still gives no reading for
  20 s at the end of a line, Kinoko reports every check as "audit could not be read
  once things had settled". Read that as "the API or the client did not answer", then
  look at the faults on the way.
- A probe command stops after 30 s of guest time.

## First runs (2026-11-23, image `sha-7dce4fa`)

No check on claims, acknowledged tasks, terminal statuses or crash recovery broke on
either engine (about 26,000 lines, 153,000 actions and 37,000 faults in three runs).

One product finding, PostgreSQL only: when PostgreSQL comes back on another address
and the API's connections got no FIN or RST, the API keeps answering `/health` but
every request that needs the database hangs. Its 10 pool connections and its lock
session retransmit to the old address, and the lock watchdog in
`packages/storage-postgres/src/boot.ts` waits for a query that never returns, so the
API neither reconnects nor exits. With Docker on a Mac the hang lasted 934 s, until
the kernel dropped the connections. In Kinoko 203 of 7,976 lines ended this way (96 %
of them after `postgres down`, none with a later `app down`).

Open: the 6 SQLite lines where the audit gave no reading had 20 or more `work`
commands running at once and no fault pattern. That is load in the client container.
A lighter `work` (one agent per command) or a cheaper audit should remove them.

## Limits

- The simulated workers register no active session. Crash recovery therefore takes the
  "no session" path only. The "stale session" path is not covered.
- Schedules and workflow steps are not covered.
- Both compose files set `MULTI_RUNTIME_ENABLED` to `false`, and the default is `true`. The
  simulated workers register without a runtime identity. The runtime pool release path is
  therefore not covered.
