# Extension templates

Ready-to-install extension bundles. Each folder holds `manifest.json`, `hooks.ts`, and a README with its config.

| Name | Event | What it does |
|---|---|---|
| `require-ticket-ref` | `pre.task.create` | Blocks REST, MCP, and Slack tasks that do not name a ticket |
| `notify-on-complete` | `post.task.completed`, `post.task.failed` | Posts a summary to a Slack channel |
| `require-verification-note` | `pre.tool.call` | Refuses completion without a `Verified:` line in the output |

Install one with the REST route or the `extension-install` MCP tool, then enable it from Settings, Extensions:

```bash
bun scripts/extensions/install-template.ts require-ticket-ref --config '{"pattern":"\\bDES-\\d+\\b"}'
```

The hook contract is served at `GET /api/extensions/type-defs`. The `swarm-extensions` seeded skill teaches agents the same flow.
