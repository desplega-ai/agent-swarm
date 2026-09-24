# Swarm Extensions

An extension is a trusted TypeScript hook bundle that runs inside the swarm API server. Use one when a rule must apply to the whole swarm: block or rewrite new tasks, route Slack channels, suppress follow-ups, change stalled-task remediation, guard tool calls, or react after a task or tool call finishes.

Do not use an extension for work that one task, one script, or one schedule can do.

## Install only from the catalog

Extensions install only from the predefined catalog in the repo (`templates/extensions/<name>/`). Inline bundles are rejected with `inline_install_disabled`. To ship a new extension, open a PR that adds a template directory (see Bundle shape below); it becomes installable once that build is deployed.

## Tools

`extension-catalog`, `extension-install` and `extension-list`. They are deferred. Load them with your harness tool search before the first call.

`extension-catalog` lists the predefined extensions, the assets each declares, and whether it is installed. `extension-install` takes `{ template: "<name>" }` (plus optional `priority` and `config`), validates the bundle (manifest, imports, typecheck against the hook contract, script typecheck) and stores it. Any authenticated agent, including a worker, can install. Your agent is recorded as its owner in `createdByAgentId`; `extension-list` exposes that field. Always send your `X-Agent-ID` when using REST so ownership is attributed to you.

Install also creates the `ext:<name>` agent and every asset the extension declares. Scripts are live and callable right away (scripts have no enabled state). Schedules are created disabled.

Workers may install subsequent versions only for their own extensions, and PATCH or DELETE their own disabled drafts. Ownership stays with the original creator; each version records its writer as `changedByAgentId`. Leads, operators, and dashboard users retain access to all bundles.

A new install is disabled and inert. A lead, operator, or dashboard user must enable it with `extension-enable` or `POST /api/extensions/{id}/enable`. Enabling turns its schedules on; disabling pauses them and remembers which ones you had turned off. Workers cannot enable, disable, or activate versions. Report the extension name and the required activation step.

Installing a catalog template whose content changed stages a new version without activating it. Workers may stage updates while an extension is enabled, but cannot PATCH or change its live config/priority. Ask a lead or operator to make those changes. `EXTENSION_ALLOW_LEAD_ACTIVATION=false` restricts activation to operators/dashboard users.

Uninstall (`extension-delete`, disabled extensions only) deletes the assets you never edited and detaches the ones you did, so your edits survive.

## Get the contract before you write hooks

Fetch the generated type definitions and read them. Do not guess event names or field names.

```bash
curl -s "$MCP_BASE_URL/api/extensions/type-defs" \
  -H "X-Agent-ID: $AGENT_ID" -H "Authorization: Bearer ${AGENT_SWARM_API_KEY:-$API_KEY}"
```

`$MCP_BASE_URL`, `$AGENT_ID`, and `$AGENT_SWARM_API_KEY` (or `$API_KEY`) are in every worker environment. The response is the `swarm-extension` module declaration: every event, its payload, and what a `modify` result may change.

## Events

| Event | When | Result |
|---|---|---|
| `pre.task.create` | before any task is stored (REST, MCP, Slack, schedule, workflow, webhook, follow-up) | `block(reason)`, `modify({ priority, agentId, tags, description, ... })`, or nothing |
| `pre.task.followUp` | before the lead follow-up task for a finished worker task | `block`, `modify({ description, priority, agentId })`, or nothing |
| `pre.slack.route` | before a Slack message becomes a task | `modify({ target: { kind: "agent", agentId } })`, `{ kind: "lead" }`, `{ kind: "broadcast" }` |
| `pre.heartbeat.remediate` | after the heartbeat sweep finds a stalled task | `modify({ proposedAction: "record" | "fail" | "supersede-resume" })` |
| `pre.tool.call` | before an agent MCP tool call runs | `block(reason)` or `modify({ args })` |
| `post.task.created`, `post.task.completed`, `post.task.failed`, `post.task.cancelled`, `post.task.superseded`, `post.task.progress` | after the change is committed | none |
| `post.slack.message`, `post.tool.call` | after the message or tool call finished | none |

`event.origin` on `pre.task.create` tells where the task comes from: `rest`, `app`, `mcp`, `slack`, `schedule`, `workflow`, `webhook`, `followUp`, or `extension:<name>`.

## Bundle shape

A predefined extension is a directory `templates/extensions/<name>/` with exactly one manifest, `manifest.yaml`, `manifest.yml` or `manifest.json`, plus the files it references and a `README.md`. Only `runtime: "api"` is supported. Type the manifest with the generated JSON Schema, `templates/extensions/manifest.schema.json`:

```yaml
# yaml-language-server: $schema=../manifest.schema.json
name: task-digest
description: Daily digest of completed and failed tasks
version: 1.0.0
runtime: api
assets:
  hooks: hooks.ts
  scripts:
    - name: task-digest-collect          # must start with "<name>-"
      file: scripts/collect.ts
      description: Count tasks finished in the last 24 hours
  schedules:
    - name: task-digest-daily            # must start with "<name>-"
      script: task-digest-collect        # a script declared above
      cronExpression: "0 9 * * *"        # or intervalMs, exactly one
      timezone: UTC
```

A JSON manifest carries `"$schema": "../manifest.schema.json"` instead. After changing a template, run `bun run build:extension-catalog` and commit `src/extensions/catalog.generated.json`.

Rules for `hooks.ts`:

- Import only from `swarm-extension`, `zod`, and `stdlib`. Relative imports, other packages, and dynamic imports are rejected.
- Export the extension as `default`. Export `config` (a Zod schema) when the extension takes configuration. Activation validates `config` against it.
- Return `block(reason)` or `modify(data)` from pre hooks. Return nothing to continue.
- Keep handlers fast. A handler is cancelled after 5 seconds. Five consecutive failures auto-disable the extension.
- Handlers run outside database transactions and must not assume ordering with other extensions. Use `priority` in `api.on(event, handler, { priority })` when order matters (lower runs first).

## Minimal hooks file

```ts
import { block, modify, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({ pattern: z.string().default("DES-\\d+") });

const manifest = {
  name: "require-ticket-ref",
  description: "Blocks REST and MCP tasks that do not name a ticket",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.task.create", (event, ctx) => {
    if (event.origin !== "rest" && event.origin !== "mcp") return;
    if (new RegExp(ctx.config.pattern).test(event.description)) return;
    return block(`Task must reference a ticket matching ${ctx.config.pattern}`);
  });

  api.on("post.task.completed", async (event, ctx) => {
    await ctx.state.incr("completed");
    ctx.log.info("task completed", { id: event.task.id });
  });
};

export default extension;
```

## Context (`ctx`)

- `ctx.config`: the validated configuration.
- `ctx.state`: per-extension key-value store (`get`, `set`, `incr`, `del`).
- `ctx.swarm`: the swarm SDK. Call any script-exposed tool by name with underscores, for example `await ctx.swarm.slack_post({ channelId, message })` or `await ctx.swarm.task_send({ ... })`. Calls made from a hook carry the `ext:<name>` identity, which has lead privileges while the extension is enabled. Calls resolve with `{ success, status, data }` and do not throw on a tool error. Check `success` and throw when the hook must fail. The type definitions import `SwarmSdk` from `swarm-sdk`. Call the `script-query-types` tool (or `GET /api/scripts/type-defs`) to get `swarm-sdk.d.ts` with every method name and argument type before you use `ctx.swarm`.
- `ctx.log`: structured logger. Entries appear in the extension run log on the dashboard.
- `ctx.signal`: abort signal for the 5-second cap.

## Verify

1. Call `extension-list` and confirm the name, version, and `enabled: false`. The install response lists the assets it created.
2. Report the enable step. After a lead or operator enables it, the dashboard run log shows every dispatch with its result (`continue`, `modify`, `block`, or `error`).
3. Trigger the event once and confirm the effect (for example, a blocked REST task returns HTTP 422 with your reason).

## Common mistakes

- Guessing event names. Fetch the type definitions.
- Using `import` from a package other than `swarm-extension`, `zod`, or `stdlib`.
- Returning a plain object instead of `block(...)` or `modify(...)`.
- Modifying fields the event does not allow. Read the `*Modify` type for that event.
- Expecting the extension to run after install. Its hooks and schedules run only after a lead or operator enables it.
- Sending an inline `manifest`/`files` bundle. Install takes a catalog `template` name only.
- Blocking tasks from every origin. Check `event.origin` so schedules, workflows, and follow-ups keep working unless you mean to block them.
