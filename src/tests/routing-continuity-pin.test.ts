import { describe, expect, test } from "bun:test";
import continuityPin from "../be/seed-scripts/catalog/default-continuity-pin";
import type { RoutingCtx } from "../routing/types";

const workerId = "continuity-parent-agent";

function ctx(): RoutingCtx {
  return {
    via: "delegation",
    task: {
      description: "Implement the follow-up endpoint",
      source: "mcp",
      tags: [],
      priority: 50,
    },
    candidates: [
      {
        id: workerId,
        name: "parent worker",
        role: "backend",
        capabilities: [],
        status: "idle",
        isLead: false,
        activeTaskCount: 0,
      },
    ],
    continuity: {
      parent: {
        id: "parent-task",
        agentId: workerId,
        agentRole: "backend",
        description: "Implement the parent endpoint",
        status: "in_progress",
      },
      chainDepth: 1,
    },
  };
}

describe("default continuity pin script", () => {
  test("pins same or unavailable classifications and advises a fresh assignment on mismatch", async () => {
    const same = await continuityPin(ctx(), {
      swarm: {
        classify: async () => ({
          success: true,
          status: 200,
          data: { result: { label: "continue-same-activity" } },
        }),
      },
    } as never);
    const unavailable = await continuityPin(ctx(), {
      swarm: { classify: async () => ({ success: true, status: 200, data: { result: null } }) },
    } as never);
    const different = await continuityPin(ctx(), {
      swarm: {
        classify: async () => ({
          success: true,
          status: 200,
          data: { result: { label: "switch-to-different-activity" } },
        }),
      },
    } as never);

    expect(same).toEqual({ assignTo: workerId });
    expect(unavailable).toEqual({ assignTo: workerId });
    expect(different).toMatchObject({
      promptDirectives: [expect.stringContaining("consider assigning fresh")],
      note: "continuity pin broken: intent mismatch",
    });
    expect(different.assignTo).toBeUndefined();
  });
});
