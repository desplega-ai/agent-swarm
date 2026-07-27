---
name: routing-rules
description: Author and register lifecycle routing rules backed by global catalog scripts
---

# Routing Rules

Create a lifecycle routing rule as a global catalog script, then register that script as an edge handler. Registration is available through the scripts SDK REST bridge only: do not create or look for an MCP tool for handler CRUD.

## Authoring Flow

1. Define the handler's intent in plain language: which edge it applies to, what it should route or guard, and its matcher constraints.
2. Write the global routing script against the `RoutingCtx` / `RoutingResult` contract — both are in the generated script types, so you can import and annotate them.
3. Save the script with `script_upsert` using `scope: "global"`.
4. Run a small inline `script_run` that registers it through `ctx.swarm.routing_handler_register(...)`.
5. Call `ctx.swarm.routing_dry_run(...)` to read back a proposed decision before enabling or changing a rule.
6. Report a concise human-readable summary: edge, script, flavor/mode, priority, matcher, and whether it is enabled.

## Result Contract

A handler returns a `RoutingResult`. The fields that affect assignment:

| Field | Effect | Applied when |
|---|---|---|
| `assignTo` | Hard-assign to that agent id | `mode: "hard"` only |
| `unassign` | Drop the inherited pin, send to the unassigned pool | `hard` **and** `soft` |
| `block` | Suppress the action, hand the Lead a reroute-decision | `mode: "hard"` only |
| `mutate` | Merge tags / priority / modelTier / routingAffinity | always (composes) |
| `promptDirectives`, `note` | Advisory guidance rendered into the assignee's prompt | always |

`unassign` is the one decisive action a **soft** handler may apply, because it hands routing back to the default router rather than taking authority for itself. It exists because callers pin a child to its parent's worker *before* routing runs, so `assignTo` alone cannot express "not this agent". It is mutually exclusive with `assignTo`, and ignored at `via: "claim"` (the task is already pooled, so there is no pin to drop).

A soft handler's `assignTo` / `block` stay suggestions: they are persisted on the task and surfaced to the Lead/worker, and their deviation rate is what justifies promoting a rule to `hard`.

## Dry Runs Are Read-Only

`routing_dry_run` executes the real script, so it runs with a **read-only `ctx.swarm`**: mutating methods (`task_send`, `slack_post`, `config_set`, `script_run`, …) reject, and no routing bus events are emitted. Reads — including `classify` — work normally. If a handler needs a write to do its job, that write cannot be exercised by a dry run; test it by enabling the rule behind a narrow matcher instead.

## Registration Example

Use an inline script after the global script has been saved:

```ts
export default async function register(_args: unknown, ctx: ScriptContext) {
  const result = await ctx.swarm.routing_handler_register({
    name: "route-pr-work-to-reviewers",
    edge: "task.before_assign",
    scriptName: "route-pr-work-to-reviewers",
    flavor: "route",
    mode: "soft",
    priority: 100,
    matcher: {
      via: "creation",
      vcsRepo: "acme/service",
      filter: "(payload) => payload.taskType === 'pull-request-review'",
    },
    enabled: true,
  });

  if (!result.success) throw new Error(`Handler registration failed: ${JSON.stringify(result.data)}`);
  return result.data;
}
```

Use only the supported matcher keys: `via`, `source`, `slackChannelId`, `vcsRepo`, `agentId`, `taskType`, and `filter`. The `filter` is a string-form payload predicate and is validated during registration.

Matcher gotcha — `source` is the task's INGRESS channel, not a topic tag: only tasks created by the real Slack message ingestion carry `source: "slack"`. A task created through `send-task`/`task-action` has `source: "mcp"` even when it carries `slackChannelId`/`slackThreadTs`. To match "anything tied to a Slack channel", match on `slackChannelId` (or use `filter`) instead of `source`. Always confirm your matcher with `swarm.routing_dry_run` using an envelope shaped like the real ingress.
