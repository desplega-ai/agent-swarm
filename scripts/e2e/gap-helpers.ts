import { asRecord, expectStatus, pollUntil } from "./http";
import type { ScenarioContext } from "./run";

/**
 * Finishes every pending / in-progress task so the next scenario's /api/poll claims its own task,
 * not a leftover. Each task is claimed by its assignee, then completed.
 */
export async function drainTasks(ctx: ScenarioContext): Promise<void> {
  for (let round = 0; round < 6; round++) {
    const response = await ctx.api("GET", "/api/tasks?fields=full&limit=200");
    expectStatus(response, [200], "list tasks to drain");
    const open = (asRecord(response.json).tasks as unknown[])
      .map(asRecord)
      .filter((t) => (t.status === "pending" || t.status === "in_progress") && t.agentId);
    if (open.length === 0) return;
    for (const t of open) {
      const agentId = String(t.agentId);
      if (t.status === "pending") {
        await ctx.api("GET", "/api/poll", { agentId });
        await pollUntil(
          async () => {
            const cur = asRecord((await ctx.api("GET", `/api/tasks/${t.id}`)).json).status;
            return cur !== "pending";
          },
          3_000,
          250,
        );
      }
      await ctx.api("POST", `/api/tasks/${t.id}/finish`, {
        agentId,
        body: { status: "completed", output: "drained by gap e2e" },
      });
    }
  }
}
