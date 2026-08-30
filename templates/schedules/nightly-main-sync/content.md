# Nightly Main Checkout Sync

Install one **enabled `agent-task`** schedule named `nightly-main-sync` with cron `0 3 * * *`, timezone `UTC`, and a lead/DevOps coordinator target. Do **not** use host crontab or a `targetType=script` schedule: catalog scripts run with `fsMode: none` and agent personal volumes are isolated.

## Coordinator task prompt

You are the Nightly Main Checkout Sync coordinator. This is a fail-closed maintenance run. Synchronize only `main` refs using `/usr/local/bin/sync-main-checkouts.sh`; never run `checkout`, `reset`, `stash`, `clean`, or a merge on a feature/work branch.

1. Obtain an overlap lock before dispatching children (for example an atomic `mkdir` lock under the coordinator's durable workspace). If already held, fail this run; do not wait or overlap.
2. Enumerate all registered agents. Dispatch one child task to **each reachable agent**, targeted to that agent, with this exact command:
   ```sh
   /usr/local/bin/sync-main-checkouts.sh /workspace/personal/repos
   ```
   The child must return the command's complete JSON-lines receipts and exit status. A missing root, inaccessible agent, command failure, unsafe receipt, or child timeout is a failure.
3. Separately identify the configured Finn host-capable agent (`FINN_HOST_CAPABLE_AGENT_ID`). Validate that it can see both `/usr/local/bin/sync-main-checkouts.sh` and `/home/dev/Factory` before dispatch. If either is absent, fail closed. Run this **additional** host child on that agent:
   ```sh
   /usr/local/bin/sync-main-checkouts.sh /home/dev/Factory
   ```
   Do not mount, copy, or inspect another agent's `/workspace/personal` directory from the coordinator.
4. Poll every child until terminal. Do not complete while a child remains pending/running. Aggregate every receipt. The parent passes only when every non-skipped clone has `status: "green"`, every required root produced a receipt, and every child completed with exit status zero. Skips are allowed only for direct non-Git entries and symlinks; report them explicitly.
5. Return JSON containing the parent task ID, every child task ID/status, each root receipt, and an overall `green`/`failed` verdict. Preserve the lock until all children are terminal, then remove it.

## Operational rules

- The primitive fetches `origin/main`, checks ancestry, and fast-forwards only `refs/heads/main`. It intentionally leaves checked-out work branches, index, and worktree bytes untouched.
- Dirty checked-out `main`, divergent `main`, missing remotes, auth/fetch failures, missing roots, and overlap are unsafe/failing outcomes. Escalate rather than repairing them.
- Enable only after validating the Finn runtime path. After installation, invoke `run-schedule-now` seven times serially and retain parent/child receipts as evidence.
