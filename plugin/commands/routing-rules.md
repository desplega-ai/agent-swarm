---
description: Author and register lifecycle routing rules backed by global catalog scripts
argument-hint: <routing-rule-request>
---

# Routing Rules

Create a lifecycle routing rule as a global catalog script, then register that script as an edge handler. Registration is available through the scripts SDK REST bridge only: do not create or look for an MCP tool for handler CRUD.

## Authoring Flow

1. Define the handler's intent in plain language: which edge it applies to, what it should route or guard, and its matcher constraints.
2. Write the global routing script. The Phase 3 contract names are `RoutingCtx` and `RoutingResult`; design the script around those names now. They are not yet included in the Phase 2 script type definitions, so do not add imports or annotations that would make `script_upsert` fail until Phase 3 lands them.
3. Save the script with `script_upsert` using `scope: "global"`.
4. Run a small inline `script_run` that registers it through `ctx.swarm.routing_handler_register(...)`.
5. In Phase 7, call `ctx.swarm.routing_dry_run(...)` to read back a proposed decision before enabling or changing a rule. That endpoint does not exist yet in Phase 2.
6. Report a concise human-readable summary: edge, script, flavor/mode, priority, matcher, and whether it is enabled.

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
