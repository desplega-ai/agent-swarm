# Kinoko workloads for the API

[Kinoko](https://kinoko.sh) runs the containers of a `compose.yaml` in a deterministic
hypervisor, injects faults, and reports each broken check with the steps to it
([docs](https://kinoko.sh/docs.md)). These workloads test what the other suites do not:
timing races in the storage layer under crashes and partitions.

| Workload | Containers | Faults |
|---|---|---|
| `postgres/` | API, PostgreSQL 16 with pgvector, client | API down, database down, API cut from database, API slow (to database, to all), client cut from API |
| `sqlite/` | API on a SQLite file in a volume, client | API down, client cut from API |

There is no LLM and no worker in the guest. The model's actions play the clients over
HTTP: an operator that creates and cancels tasks and runs heartbeat sweeps, and four
workers that poll, claim, write progress, finish, or die with a task.

## Files

- `build.sh`: builds the two images for linux/amd64 and writes both `model.lua` files.
- `images/swarm/`: the API image of one commit plus the client scripts in `/k`.
  - `k/act`: one client step (`work`, `create`, `replay`, `cancel`, `sweep`). It writes every answer of the API to a journal.
  - `k/audit`: compares the journal with `GET /api/tasks` and prints the numbers the checks read.
  - `k/serve`: starts the API again when it exits (on Postgres it exits when it loses the one-process lock).
- `images/postgres/`: PostgreSQL 16 with pgvector on alpine, without LLVM (97 MB; `pgvector/pgvector:pg16` is 480 MB).
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
| the API answers after things settle | eventually | the task list reads |
| no task stays in_progress without a live agent | eventually | no `in_progress` task is 45 s without an update while the API reads |
| `<action>`: the answers fit the contract | reply | no answer contradicts an earlier one (see `viol=` in `k/act`) |
| `<action>`: no server error on SQLite | reply | no 5xx answer (SQLite variant only) |

Three `sometimes` goals show that a run reached a claim, a completion and a crash
recovery. The heartbeat runs every 2 s and takes a task with no session after 6 s
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

## Limits

- A setup step must answer within 30 s. The first boot applies every migration, so the
  model waits for the API in several short steps.
- A command of an action stops after 10 s of guest time. Each request of `k/act` stops
  after 4 s, and a step makes at most two requests.
- The simulated workers register no active session. Crash recovery therefore takes the
  "no session" path only. The "stale session" path is not covered.
- Schedules and workflow steps are not covered.
