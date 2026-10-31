import { asRecord, expect, expectStatus } from "../http";
import { SkipError } from "../report";
import type { Scenario, ScenarioContext } from "../run";
import { claim } from "./slack-helpers";

// PR #2575: `pre.task.steer` lets an extension rewrite or block steering before any side effect.
// Needs the SUT started with:
//   --sut-env EXTENSION_ALLOW_INLINE_INSTALL=true --sut-env STEERING_ENABLED=true
const HOOKS = `
import { block, modify, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({
  action: z.enum(["continue", "modify", "block", "throw"]),
  prefix: z.string().default("rewritten: "),
});
const manifest = {
  name: "gap-steering-policy",
  description: "Rewrites, blocks or throws on steering messages",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.task.steer", async (event, ctx) => {
    switch (ctx.config.action) {
      case "continue":
        return { action: "continue" };
      case "modify":
        return modify({ message: ctx.config.prefix + event.message });
      case "block":
        return block("Steering denied by policy");
      case "throw":
        throw new Error("Steering policy failed");
    }
  });
};

export default extension;
`;

const MANIFEST = {
  name: "gap-steering-policy",
  description: "Rewrites, blocks or throws on steering messages",
  version: "1.0.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
};

async function messages(ctx: ScenarioContext, taskId: string): Promise<string[]> {
  const response = await ctx.api("GET", `/api/tasks/${taskId}/steering-messages`);
  expectStatus(response, [200], "list steering messages");
  const list = asRecord(response.json).messages as { body: string }[];
  return list.map((row) => row.body);
}

async function installAndEnable(ctx: ScenarioContext, action: string): Promise<string> {
  const installed = await ctx.api("POST", "/api/extensions/install", {
    body: { manifest: MANIFEST, files: { "hooks.ts": HOOKS }, config: { action } },
  });
  if (installed.status === 400 && installed.text.includes("inline_install_disabled")) {
    throw new SkipError("start the SUT with --sut-env EXTENSION_ALLOW_INLINE_INSTALL=true");
  }
  expectStatus(installed, [200], `install policy ${action}`);
  const id = String(asRecord(asRecord(installed.json).extension).id);
  expectStatus(await ctx.api("POST", `/api/extensions/${id}/enable`), [200], "enable policy");
  return id;
}

async function uninstall(ctx: ScenarioContext, id: string): Promise<void> {
  expectStatus(await ctx.api("POST", `/api/extensions/${id}/disable`), [200], "disable policy");
  expectStatus(await ctx.api("DELETE", `/api/extensions/${id}`), [200], "uninstall policy");
}

export const gapSteerHooks: Scenario = {
  name: "gap-steer-hooks",
  order: 1020,
  async run(ctx) {
    const lead = await ctx.api("POST", "/api/agents", {
      body: { name: `gap-steer-lead-${ctx.nonce}`, isLead: true },
    });
    const leadId = String(asRecord(lead.json).id);
    const worker = await ctx.api("POST", "/api/agents", {
      body: { name: `gap-steer-worker-${ctx.nonce}`, role: "worker", status: "online" },
    });
    const workerId = String(asRecord(worker.json).id);
    const created = await ctx.api("POST", "/api/tasks", {
      body: { task: "gap steer target", agentId: workerId, routingReason: "human_pinned" },
    });
    expectStatus(created, [201], "create steer target");
    const taskId = String(asRecord(created.json).id);
    await claim(ctx, workerId, taskId);
    void leadId;

    const steer = (message: string) =>
      ctx.api("POST", `/api/tasks/${taskId}/steer`, { body: { message, mode: "queue" } });

    // Baseline, no extension: the original text is queued.
    const base = await steer("baseline message");
    if (base.status === 403 && base.text.includes("Steering is disabled")) {
      throw new SkipError("start the SUT with --sut-env STEERING_ENABLED=true");
    }
    expectStatus(base, [200], "baseline steer");
    expect((await messages(ctx, taskId)).includes("baseline message"), "baseline text queued");

    // modify: the rewritten text is queued, the original never is.
    let id = await installAndEnable(ctx, "modify");
    expectStatus(await steer("hello"), [200], "steer under modify");
    const queued = await messages(ctx, taskId);
    expect(queued.includes("rewritten: hello"), `rewritten text queued: ${queued.join(" | ")}`);
    expect(!queued.includes("hello"), "original text was queued despite the rewrite");
    await uninstall(ctx, id);

    // block: 403 and nothing written.
    id = await installAndEnable(ctx, "block");
    const before = await messages(ctx, taskId);
    const blocked = await steer("blocked text");
    expect(blocked.status === 403, `block answers 403, got ${blocked.status}: ${blocked.text}`);
    expect(blocked.text.includes("Steering denied by policy"), "403 carries the policy reason");
    const after = await messages(ctx, taskId);
    expect(
      after.length === before.length && !after.includes("blocked text"),
      "a blocked steer still wrote a steering row",
    );
    const logs = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_log WHERE taskId = ? AND eventType = 'task_steering' AND newValue LIKE '%blocked text%'",
      [taskId],
    );
    expect(logs?.n === 0, "a blocked steer wrote a steering log");
    await uninstall(ctx, id);

    // throw: fails open, the original text is delivered.
    id = await installAndEnable(ctx, "throw");
    expectStatus(await steer("fail open text"), [200], "steer under a throwing hook");
    expect(
      (await messages(ctx, taskId)).includes("fail open text"),
      "throwing hook did not fail open",
    );
    await uninstall(ctx, id);

    // After removal the original text flows again (control).
    expectStatus(await steer("after removal"), [200], "steer after uninstall");
    expect((await messages(ctx, taskId)).includes("after removal"), "post-uninstall text queued");
  },
};
