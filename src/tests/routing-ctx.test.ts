import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  initDb,
  resolveEffectiveTaskOptions,
  startTask,
  updateAgentProfile,
} from "../be/db";
import { typecheckScript } from "../be/scripts/typecheck";
import { buildRoutingCtx } from "../routing/ctx";
import { isDecisive, RoutingCtxSchema, RoutingResultSchema } from "../routing/types";
import { slackContextKey } from "../tasks/context-key";
import { classify } from "../utils/internal-ai/classify";

const TEST_DB_PATH = "./test-routing-ctx.sqlite";

function removeDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB_PATH + suffix);
    } catch {
      // Ignore missing test database files.
    }
  }
}

beforeAll(() => {
  removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  removeDbFiles();
});

describe("routing contract", () => {
  test("builds the task envelope, live candidate counts, and three-level continuity", () => {
    const lead = createAgent({
      name: "routing-lead",
      isLead: true,
      status: "idle",
      role: "lead",
      capabilities: ["coordination"],
      maxTasks: 5,
    });
    const worker = createAgent({
      name: "routing-worker",
      isLead: false,
      status: "idle",
      role: "typescript",
      capabilities: ["typescript", "routing"],
      maxTasks: 3,
    });
    updateAgentProfile(lead.id, { role: "lead", capabilities: ["coordination"] });
    updateAgentProfile(worker.id, {
      role: "typescript",
      capabilities: ["typescript", "routing"],
    });
    const activeTask = createTaskExtended("active worker task", { agentId: worker.id });
    expect(startTask(activeTask.id)?.status).toBe("in_progress");

    const root = createTaskExtended("root task", { agentId: lead.id, source: "api" });
    const child = createTaskExtended("child task", {
      agentId: worker.id,
      parentTaskId: root.id,
    });
    const grandchild = createTaskExtended("grandchild task", {
      agentId: worker.id,
      parentTaskId: child.id,
    });
    const contextKey = slackContextKey({
      channelId: "C_ROUTING",
      threadTs: "1234.5678",
    });
    const routingAffinity = {
      sourceAgentId: worker.id,
      role: "typescript",
      capabilities: ["typescript"],
    };

    const effective = resolveEffectiveTaskOptions("route this task", {
      agentId: worker.id,
      source: "slack",
      taskType: "review",
      tags: ["routing", "urgent"],
      parentTaskId: grandchild.id,
      modelTier: "smart",
      priority: 80,
      routingAffinity,
      contextKey,
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
    });
    const ctx = buildRoutingCtx("creation", effective, { proposedAgentId: worker.id });

    expect(RoutingCtxSchema.safeParse(ctx).success).toBe(true);
    expect(ctx).toMatchObject({
      via: "creation",
      proposedAgentId: worker.id,
      task: {
        description: "route this task",
        source: "slack",
        taskType: "review",
        tags: ["routing", "urgent"],
        parentTaskId: grandchild.id,
        modelTier: "smart",
        priority: 80,
        routingAffinity,
        slackChannelId: "C_ROUTING",
        slackThreadTs: "1234.5678",
        vcsProvider: "github",
        vcsRepo: "desplega-ai/agent-swarm",
        contextKey,
      },
      continuity: {
        parent: {
          id: grandchild.id,
          agentId: worker.id,
          agentRole: "typescript",
          description: "grandchild task",
          status: "pending",
        },
        chainDepth: 3,
      },
    });
    expect(ctx.candidates.find((candidate) => candidate.id === worker.id)).toMatchObject({
      name: "routing-worker",
      role: "typescript",
      capabilities: ["typescript", "routing"],
      isLead: false,
      activeTaskCount: 1,
      maxTasks: 3,
    });
  });

  test("resolveEffectiveTaskOptions preserves plain creation values", () => {
    const options = {
      source: "api" as const,
      taskType: "chore",
      tags: ["plain"],
      priority: 61,
      vcsProvider: "gitlab" as const,
      vcsRepo: "group/project",
    };
    const effective = resolveEffectiveTaskOptions("plain task", options);
    expect(effective).toEqual({ description: "plain task", options });

    const created = createTaskExtended("plain task", { ...options });
    expect(created).toMatchObject({
      task: "plain task",
      source: "api",
      taskType: "chore",
      tags: ["plain"],
      priority: 61,
      vcsProvider: "gitlab",
      vcsRepo: "group/project",
    });
  });

  test("resolveEffectiveTaskOptions and task creation preserve parent inheritance", () => {
    const parentAgent = createAgent({
      name: "routing-parent-agent",
      isLead: false,
      status: "idle",
      role: "backend",
      capabilities: ["api"],
    });
    updateAgentProfile(parentAgent.id, { role: "backend", capabilities: ["api"] });
    const contextKey = slackContextKey({
      channelId: "C_PARENT",
      threadTs: "2222.3333",
    });
    const routingAffinity = {
      sourceAgentId: parentAgent.id,
      role: "backend",
      capabilities: ["api"],
    };
    const parent = createTaskExtended("parent inheritance source", {
      agentId: parentAgent.id,
      slackChannelId: "C_PARENT",
      slackThreadTs: "2222.3333",
      slackUserId: "U_PARENT",
      contextKey,
      routingAffinity,
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
    });

    const effective = resolveEffectiveTaskOptions("inherited child", {
      parentTaskId: parent.id,
    });
    expect(effective.options).toMatchObject({
      parentTaskId: parent.id,
      slackChannelId: "C_PARENT",
      slackThreadTs: "2222.3333",
      slackUserId: "U_PARENT",
      contextKey,
      routingAffinity,
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
    });

    const child = createTaskExtended("inherited child", { parentTaskId: parent.id });
    expect(child).toMatchObject({
      task: "inherited child",
      parentTaskId: parent.id,
      slackChannelId: "C_PARENT",
      slackThreadTs: "2222.3333",
      slackUserId: "U_PARENT",
      contextKey,
      routingAffinity,
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
    });
  });

  test("resolveEffectiveTaskOptions and task creation preserve Slack normalization", () => {
    const contextKey = slackContextKey({
      channelId: "C_CANONICAL",
      threadTs: "4444.5555",
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const effective = resolveEffectiveTaskOptions("normalized task", {
        contextKey,
        slackChannelId: "C_WRONG",
        slackThreadTs: "9999.0000",
      });
      expect(effective.options).toMatchObject({
        contextKey,
        slackChannelId: "C_CANONICAL",
        slackThreadTs: "4444.5555",
      });

      const created = createTaskExtended("normalized task", {
        contextKey,
        slackChannelId: "C_WRONG",
        slackThreadTs: "9999.0000",
      });
      expect(created).toMatchObject({
        contextKey,
        slackChannelId: "C_CANONICAL",
        slackThreadTs: "4444.5555",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("RoutingResult accepts continue/decisive results and identifies decisions", () => {
    expect(RoutingResultSchema.parse({})).toEqual({});
    expect(isDecisive({ note: "continue" })).toBe(false);
    expect(isDecisive({ assignTo: crypto.randomUUID() })).toBe(true);
    expect(isDecisive({ block: { reason: "no eligible agent" } })).toBe(true);
  });

  test("routing script contract typechecks valid results and rejects invalid results", () => {
    const valid = typecheckScript(`
      import type { RoutingCtx, RoutingResult } from "swarm-sdk";

      export default async function route(ctx: RoutingCtx): Promise<RoutingResult> {
        if (ctx.candidates.length === 0) {
          return { block: { reason: "No registered candidates" } };
        }
        return {
          assignTo: ctx.proposedAgentId ?? ctx.candidates[0]?.id,
          mutate: { tags: [...ctx.task.tags, "routed"], modelTier: "smart", priority: 70 },
          promptDirectives: ["Keep the existing task context."],
          note: ctx.continuity.parent?.description,
        };
      }
    `);
    expect(valid).toEqual({ ok: true });

    const invalid = typecheckScript(`
      import type { RoutingCtx, RoutingResult } from "swarm-sdk";

      export default async function route(_ctx: RoutingCtx): Promise<RoutingResult> {
        return { assignTo: 123 };
      }
    `);
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.diagnostics.join("\n")).toContain("number");
    expect(invalid.diagnostics.join("\n")).toContain("string");
  });

  test("classify returns structured results and fails open on timeout", async () => {
    const classified = await classify("fix a broken endpoint", ["bug", "feature"], {
      _completeStructured: (async () => ({
        label: "bug",
        confidence: 0.92,
        reasoning: "The endpoint is already expected to work.",
      })) as typeof import("../utils/internal-ai/complete-structured").completeStructured,
    });
    expect(classified).toEqual({
      label: "bug",
      confidence: 0.92,
      reasoning: "The endpoint is already expected to work.",
    });

    const timedOut = await classify("slow input", ["one", "two"], {
      timeoutMs: 5,
      _completeStructured: (() =>
        new Promise(
          () => {},
        )) as typeof import("../utils/internal-ai/complete-structured").completeStructured,
    });
    expect(timedOut).toBeNull();
  });
});
