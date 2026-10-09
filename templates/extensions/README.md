# Extension templates

Predefined extension bundles. These templates are the only install source: the API installs an extension by name from this catalog.

Each folder holds exactly one `manifest.yaml`, `manifest.yml`, or `manifest.json`, the files it references, and a README with its config. The folder name must equal the manifest `name`. Point the manifest at `manifest.schema.json` for editor completion:

- YAML: `# yaml-language-server: $schema=../manifest.schema.json` on the first line.
- JSON: `"$schema": "../manifest.schema.json"`.

| Name | Event | What it does |
|---|---|---|
| `github-sender-allowlist` | `pre.task.create` | Blocks GitHub webhook tasks from senders outside configured allowlists |
| `require-ticket-ref` | `pre.task.create` | Blocks REST, MCP, and Slack tasks that do not name a ticket |
| `notify-on-complete` | `post.task.completed`, `post.task.failed` | Posts a summary to a Slack channel |
| `deploy-awareness` | `pre.task.create` | Appends a one-line note to new tasks while a Dokploy deploy is in progress |
| `slack-reply-gate` | `pre.task.create` | Asks TypeSafe Jev whether Lead should answer a Slack thread follow-up; in `enforce` drops the wake-up and marks the message :mute: |
| `require-verification-note` | `pre.tool.call` | Refuses completion without a `Verified:` line in the output |
| `task-digest` | `post.task.completed`, `post.task.failed` | Ships the `task-digest-collect` script, the `task-digest-daily` schedule (09:00 UTC), the `task-digest-report` workflow, and the `task-digest-guide` skill |

A template can ship scripts, schedules, workflows (`workflows/*.yaml` or `.json`), and skills (`skills/<dir>/SKILL.md` plus optional `files/**`). Every asset name starts with `<name>-`, including the workflow `name` and the `SKILL.md` frontmatter `name`. Schedules, workflows, and skills stay off until the extension is enabled. An extension skill is global: install it on each agent with `skill-install` after you enable the extension.

Install one by name with `POST /api/extensions/install`, the `extension-install` MCP tool, or the catalog page at Settings, Extensions, Install extension. Then enable it:

```bash
bun scripts/extensions/install-template.ts require-ticket-ref --config '{"pattern":"\\bDES-\\d+\\b"}'
bun scripts/extensions/install-template.ts task-digest --enable
```

Add `--validate-only` to check the working-tree template without calling the API.

After you add or edit a template, regenerate the catalog and commit it. The API server reads `src/extensions/catalog.generated.json`, not this folder:

```bash
bun run build:extension-catalog
```

If you change `ExtensionManifestSchema` in `src/types.ts`, also run `bun run build:extension-schema` to regenerate `manifest.schema.json`.

The hook contract is served at `GET /api/extensions/type-defs`. The `swarm-extensions` seeded skill teaches agents the same flow.
