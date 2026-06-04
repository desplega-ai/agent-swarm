Use this skill when a user asks to launch, monitor, inspect, or debug a durable script workflow run. This is for the Script Workflows v1 runtime: one-off TypeScript workflow source with journaled `swarm-script`, `raw-llm`, and `agent-task` steps.

## Tool Flow

Load the script workflow tools with ToolSearch when they are not already visible:

```text
launch-script-run
get-script-run
list-script-runs
```

Use `launch-script-run` to start a one-off run. It calls the same `/api/script-runs` API as the dashboard, preserves the invoking agent identity, and starts the run in the background.

Use `get-script-run` to read terminal status and journal entries. Poll it when needed, but keep polling bounded and report progress for long runs.

Use `list-script-runs` to find recent runs or filter by `status` / `agentId`.

Do not hand-roll raw HTTP for this flow unless the tool itself is broken and you are explicitly debugging the API. The tool handles auth and `X-Agent-ID` like the existing inline `script-run` tool family.

## Source Shape

Author TypeScript workflow source as a default export. The runtime provides `args` and `ctx`.

```ts
export default async function main(args, ctx) {
  const lookup = await ctx.step.swarmScript("lookup-data", {
    scriptName: "fetch-readable",
    args: { url: args.url },
  });

  const summary = await ctx.step.rawLlm("summarize", {
    prompt: `Summarize this for an operator:\n${JSON.stringify(lookup)}`,
  });

  const task = await ctx.step.agentTask("operator-review", {
    task: `Review this summary and flag risks:\n${JSON.stringify(summary)}`,
    tags: ["script-run"],
    priority: 50,
  });

  return { lookup, summary, task };
}
```

## Label Rules

Step labels are durability keys. They must be stable and unique for each logical step. Do not reuse the same literal label inside a loop; launch will fail with `label_lint_violation`.

For looped work, include an item identifier in the label:

```ts
for (const item of args.items) {
  await ctx.step.agentTask(`review-${item.id}`, { task: item.prompt });
}
```

## Statuses

Terminal statuses to surface clearly:

- `completed` — run finished and `output` may be present.
- `failed` — run ended with `error`.
- `cancelled` — run was cancelled before completion.
- `aborted_limit` — runtime guardrail stopped the run, usually step count, agent-task count, or wall-clock cap.
- `label_lint_violation` — launch-time rejection, not a persisted run status.

When a run is not terminal, report the current status, journal count, and latest heartbeat if present.
