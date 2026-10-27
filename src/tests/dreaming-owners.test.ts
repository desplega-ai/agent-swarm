import { describe, expect, test } from "bun:test";
import owners from "../be/seed-scripts/catalog/dreaming-owners";

const LEAD = "11111111-2222-4333-8444-555555555555";

const synth = {
  actions: [
    { id: "a1", lane: "memory", op: "edit", tier: "propose", target: {}, reason: "r1" },
    { id: "a2", lane: "scriptify", op: "build", tier: "auto", target: {}, reason: "r2" },
  ],
};

function fakeCtx(dbQuery: (args: { sql: string }) => Promise<unknown>) {
  const sends: Array<Record<string, any>> = [];
  const ctx = {
    swarm: {
      db_query: dbQuery,
      kv_getOrNull: async () => null,
      kv_set: async () => ({ success: true }),
      task_send: async (args: Record<string, any>) => {
        sends.push(args);
        return { data: { task: { id: `task-${sends.length}` } } };
      },
    },
  };
  return { ctx: ctx as any, sends };
}

const rejecting = async () => {
  throw new Error("database is locked");
};

describe("dreaming-owners never throws", () => {
  test("both lookups rejecting resolves with errors and sends nothing", async () => {
    const { ctx, sends } = fakeCtx(rejecting);
    const out: any = await owners({ runId: "run-1", synth }, ctx);
    expect(out.mode).toBe("live");
    expect(out.errors.some((e: string) => e.startsWith("lead lookup:"))).toBe(true);
    expect(out.errors.some((e: string) => e.startsWith("agent lookup:"))).toBe(true);
    expect(out.errors.some((e: string) => e.startsWith("no owner"))).toBe(true);
    expect(sends).toHaveLength(0);
  });

  test("lead lookup rejecting with no actions still resolves", async () => {
    const { ctx } = fakeCtx(rejecting);
    const out: any = await owners({ runId: "run-1", synth: { actions: [] } }, ctx);
    expect(out.errors).toEqual([expect.stringMatching(/^lead lookup:/)]);
  });

  test("agent roster lookup rejecting falls back to the lead owner", async () => {
    const { ctx, sends } = fakeCtx(rejecting);
    const out: any = await owners({ runId: "run-1", leadAgentId: LEAD, synth }, ctx);
    expect(out.errors).toEqual([expect.stringMatching(/^agent lookup:/)]);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.agentId).toBe(LEAD);
    expect(out.sent[0]?.actionIds).toEqual(["a1", "a2"]);
  });
});
