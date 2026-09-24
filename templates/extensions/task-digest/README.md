# task-digest

Ships a script and a schedule alongside its hooks. It is the reference for extensions that bundle assets.

| Asset | Name | What it does |
|---|---|---|
| Script | `task-digest-collect` | Counts tasks completed and failed in the last `hours` (default 24), grouped by agent |
| Schedule | `task-digest-daily` | Runs the script every day at 09:00 UTC with `{ "hours": 24 }` |
| Hooks | `hooks.ts` | Counts `post.task.completed` and `post.task.failed` in the extension state |

Install creates the script and the schedule, owned by the `ext:task-digest` agent. The schedule stays off until the extension is enabled. Disabling the extension pauses it again.

```bash
bun scripts/extensions/install-template.ts task-digest --enable
```

Run the script by hand with `script-run name="task-digest-collect" scope="global" args={"hours":24}`.

No config.
