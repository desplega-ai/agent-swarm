# task-digest

Ships a script, a schedule, a workflow, and a skill alongside its hooks. It is the reference for extensions that bundle assets.

| Asset | Name | What it does |
|---|---|---|
| Script | `task-digest-collect` | Counts tasks completed and failed in the last `hours` (default 24), grouped by agent |
| Schedule | `task-digest-daily` | Runs the script every day at 09:00 UTC with `{ "hours": 24 }` |
| Workflow | `task-digest-report` | One `swarm-script` node that runs the script with `{ "hours": 24 }`. It has no triggers, so you trigger it by hand. |
| Skill | `task-digest-guide` | Tells agents how to get and read a digest. Bundles `example-output.json`. |
| Hooks | `hooks.ts` | Counts `post.task.completed` and `post.task.failed` in the extension state |

Install creates every asset, owned by the `ext:task-digest` agent. The script is callable at once. The schedule, workflow, and skill stay off until the extension is enabled. Disabling the extension turns them off again.

```bash
bun scripts/extensions/install-template.ts task-digest --enable
```

Run the script by hand with `script-run name="task-digest-collect" scope="global" args={"hours":24}`.

Run the workflow with `trigger-workflow` after you enable the extension.

The skill is global, so no agent sees it yet. After you enable the extension, install it on each agent that needs it with `skill-install`.

No config.
