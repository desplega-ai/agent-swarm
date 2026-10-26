# Linear Delivery Loop

One cron script, the tick, moves each issue of an enrolled Linear project one step every five minutes: agents implement, fix CI and answer review, a reviewer agent approves the head commit, and a human approves before GitHub merges. Full guide: [PLAYBOOK.md](./PLAYBOOK.md) or https://docs.agent-swarm.dev/playbooks/linear-delivery-loop.

The first project run on these rules, 14 issues closed in 7 days, is written up in [Software factories are workflows](https://www.pleasedontdeploy.com/p/software-factories-are-workflows).

## Files

| File | What it is |
|---|---|
| `scripts/linear-delivery-tick.ts` | The tick. Dry run is the default. |
| `scripts/linear-delivery-setup.ts` | Adds the missing Linear workflow states and the `delivery-loop` project label, and writes a starter config. Idempotent. |
| `config.example.json` | Every config key. Store your copy in KV `linear-delivery-loop/config`. |
| `schedule.json` | The schedule: cron `2-57/5 * * * *`, UTC, `dryRun: true`. |
| `lead-prompt.md` | A prompt that has your Lead do the setup. |

## Quick start

Steps 1, 2 and 6 need the Lead identity (`X-Agent-ID` of your Lead).

1. Store `LINEAR_API_KEY` and `GITHUB_TOKEN` as secrets and create the `linear` and `github` GraphQL script connections.
2. Upsert both scripts at global scope (`POST /api/scripts/upsert`).
3. Run `linear-delivery-setup` with `{"teamKey":"ENG"}`, read `wouldCreate`, then run it with `"dryRun": false`.
4. Fill in `config.example.json` and `PUT /api/kv/_/linear-delivery-loop/config` with `{"value": <config>}`.
5. Run `linear-delivery-tick` with `{"dryRun": true, "projectIds": ["<id>"]}` and check `controls.ok`.
6. `POST /api/schedules` with `schedule.json`.
7. `PATCH` the schedule's `scriptArgs` to `{"dryRun": false}`.
8. Add the `delivery-loop` label to a Linear project. Move issues from Backlog to Todo to release them.

The exact curl commands are in [PLAYBOOK.md](./PLAYBOOK.md#setup).

## Tests

```bash
bun run test:root -- src/tests/community-linear-delivery-loop.test.ts
```

The tests cover every row of the state table, each cap, the lock, the PR lookup, the failure classifier, escalation, project completion, the setup script, and the `script-upsert` typecheck of both scripts.
