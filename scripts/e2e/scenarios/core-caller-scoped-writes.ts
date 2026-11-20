import { sql } from "../db";
import { asRecord, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario, ScenarioContext } from "../run";
import {
  callTool,
  cancelQuietly,
  createAssignedTask,
  registerLead,
  registerWorker,
  retireAgent,
  withMcp,
} from "./core-helpers";

const GHOST_SCRIPT = "00000000-0000-4000-8000-00000000beef";

/** Mint the agent's durable `aseph_` token. The caller revokes it. */
async function mintAgentToken(ctx: ScenarioContext, agentId: string): Promise<string> {
  const response = await ctx.api("POST", `/api/agents/${agentId}/token`, { body: {} });
  expectStatus(response, [200], `mint agent token for ${agentId}`);
  const plaintext = asRecord(response.json).plaintext;
  expect(
    typeof plaintext === "string" && plaintext.startsWith("aseph_"),
    "Agent token is malformed",
  );
  return plaintext;
}

function storedSessionId(ctx: ScenarioContext, taskId: string): string | null {
  return (
    ctx.db.get<{ claudeSessionId: string | null }>(
      sql`SELECT "claudeSessionId" FROM agent_tasks WHERE id = ${taskId}`,
    )?.claudeSessionId ?? null
  );
}

/** PUT /api/tasks/{id}/session: an agent token writes only its own task's session. */
async function taskSessionWrites(ctx: ScenarioContext): Promise<void> {
  const workerA = await registerWorker(ctx, "session-owner-a");
  const workerB = await registerWorker(ctx, "session-owner-b");
  const taskA = await createAssignedTask(ctx, workerA, `session owner A ${ctx.nonce}`);
  const taskA2 = await createAssignedTask(ctx, workerA, `session owner A2 ${ctx.nonce}`);
  const taskB = await createAssignedTask(ctx, workerB, `session owner B ${ctx.nonce}`);
  const tokenA = await mintAgentToken(ctx, workerA);
  const tokenB = await mintAgentToken(ctx, workerB);
  let offeredId: string | null = null;
  try {
    const put = (taskId: string, sessionId: string, options: Record<string, unknown> = {}) =>
      ctx.api("PUT", `/api/tasks/${taskId}/session`, {
        ...options,
        body: { claudeSessionId: sessionId, provider: "claude" },
      });

    // Refused: an agent token on a task assigned to another agent.
    let response = await put(taskB, `foreign-${ctx.nonce}`, { apiKey: tokenA });
    expectStatus(response, [403], "agent token writes another agent's task session");
    expect(storedSessionId(ctx, taskB) === null, "The refused session write was stored");

    // Allowed: the agent token on its own task.
    response = await put(taskA, `own-${ctx.nonce}`, { apiKey: tokenA });
    expectStatus(response, [200], "agent token writes its own task session");
    expect(
      asRecord(response.json).claudeSessionId === `own-${ctx.nonce}` &&
        storedSessionId(ctx, taskA) === `own-${ctx.nonce}`,
      "The own-task session write was not stored",
    );

    // An offered task has no assignee yet: only the agent it is offered to writes its session.
    const offered = await ctx.api("POST", "/api/tasks", {
      body: {
        task: `session offer ${ctx.nonce}`,
        offeredTo: workerA,
        routingReason: "human_pinned",
        source: "api",
      },
    });
    expectStatus(offered, [201], "offer a task");
    offeredId = String(asRecord(offered.json).id);
    response = await put(offeredId, `offer-foreign-${ctx.nonce}`, { apiKey: tokenB });
    expectStatus(response, [403], "agent token writes the session of a task offered to another");
    response = await put(offeredId, `offer-${ctx.nonce}`, { apiKey: tokenA });
    expectStatus(response, [200], "agent token writes the session of a task offered to it");
    expect(
      storedSessionId(ctx, offeredId) === `offer-${ctx.nonce}`,
      "The offered-task session write was not stored",
    );

    // A task token is bound to its task, even for another task of the same agent.
    response = await ctx.api("POST", "/api/sessions/tokens", {
      body: { agentId: workerA, taskId: taskA, ttlMs: 120_000 },
    });
    expectStatus(response, [200], "mint task token");
    const taskToken = String(asRecord(response.json).plaintext);
    response = await put(taskA2, `sibling-${ctx.nonce}`, { apiKey: taskToken });
    expectStatus(response, [403], "task token writes a sibling task session");
    expect(storedSessionId(ctx, taskA2) === null, "The sibling session write was stored");
    response = await put(taskA, `task-token-${ctx.nonce}`, { apiKey: taskToken });
    expectStatus(response, [200], "task token writes its own task session");

    // Unchanged: the shared key, with or without X-Agent-ID, writes any task's session.
    response = await put(taskB, `operator-${ctx.nonce}`);
    expectStatus(response, [200], "shared key writes a task session");
    expect(storedSessionId(ctx, taskB) === `operator-${ctx.nonce}`, "Shared-key write lost");
    response = await put(taskB, `keyed-agent-${ctx.nonce}`, { agentId: workerA });
    expectStatus(response, [200], "shared key with X-Agent-ID writes a task session");
    expect(
      storedSessionId(ctx, taskB) === `keyed-agent-${ctx.nonce}`,
      "Shared-key write with X-Agent-ID lost",
    );
    expectStatus(
      await put("00000000-0000-4000-8000-00000000dead", "x", { apiKey: tokenA }),
      [404],
      "agent token on an unknown task",
    );
  } finally {
    await ctx.api("DELETE", `/api/agents/${workerA}/token`);
    await ctx.api("DELETE", `/api/agents/${workerB}/token`);
    for (const taskId of [taskA, taskA2, taskB]) await cancelQuietly(ctx, taskId);
    if (offeredId) await cancelQuietly(ctx, offeredId);
  }
}

/** POST /api/memory/re-embed: a worker token is refused, a lead token and the shared key run. */
async function memoryReembed(ctx: ScenarioContext, leadId: string): Promise<void> {
  const worker = await registerWorker(ctx, "reembed-worker");
  const workerToken = await mintAgentToken(ctx, worker);
  const leadToken = await mintAgentToken(ctx, leadId);
  try {
    const reembed = (options: Record<string, unknown>, agentId: string) =>
      ctx.api("POST", "/api/memory/re-embed", {
        ...options,
        body: { agentId, batchSize: 5 },
      });

    let response = await reembed({ apiKey: workerToken }, worker);
    expectStatus(response, [403], "worker token starts a re-embed");

    response = await reembed({ apiKey: leadToken }, leadId);
    expectStatus(response, [202], "lead token starts a re-embed");
    expect(asRecord(response.json).started === true, "Lead re-embed did not start");

    // Unchanged: the shared key, with or without X-Agent-ID.
    response = await reembed({}, worker);
    expectStatus(response, [202], "shared key starts a re-embed");
    response = await reembed({ agentId: worker }, worker);
    expectStatus(response, [202], "shared key with X-Agent-ID starts a re-embed");
  } finally {
    await ctx.api("DELETE", `/api/agents/${worker}/token`);
    await ctx.api("DELETE", `/api/agents/${leadId}/token`);
  }
}

/** A refused call: a tool error, or a protocol error the client throws. */
async function toolRefusal(conn: McpConnection, args: Record<string, unknown>): Promise<string> {
  try {
    const outcome = await callTool(conn, "script-apis", args);
    return outcome.isError ? outcome.text || outcome.message || "error" : "";
  } catch (error) {
    return error instanceof Error ? error.message || "error" : String(error);
  }
}

/** The script-apis tool takes only endpoint-id-shaped endpointId values. */
async function scriptApiEndpointIds(ctx: ScenarioContext, leadId: string): Promise<void> {
  await withMcp(ctx, leadId, async (conn) => {
    for (const endpointId of ["..", "../../x", "a/b", "a?b", "a%2Fb"]) {
      for (const action of ["update", "rotate", "delete"] as const) {
        const refusal = await toolRefusal(conn, { action, scriptId: GHOST_SCRIPT, endpointId });
        expect(refusal.length > 0, `script-apis ${action} accepted endpointId ${endpointId}`);
        expect(
          !/not found/i.test(refusal),
          `script-apis ${action} sent endpointId ${endpointId} to the API: ${refusal}`,
        );
      }
    }
    // A well-formed id still reaches the endpoint route, which answers not found.
    const refusal = await toolRefusal(conn, {
      action: "delete",
      scriptId: GHOST_SCRIPT,
      endpointId: "nopenopenope",
    });
    expect(/not found/i.test(refusal), `well-formed endpointId did not reach the API: ${refusal}`);
  });
}

/**
 * Agent session tokens act only on what their agent owns: their own task's provider session,
 * and a memory re-embed needs a lead. The shared key behaves as before. The script-apis tool
 * builds endpoint paths from endpoint-id-shaped values only.
 */
export const coreCallerScopedWrites: Scenario = {
  name: "core-caller-scoped-writes",
  order: 229,
  async run(ctx) {
    await taskSessionWrites(ctx);
    const leadId = await registerLead(ctx, "caller-scoped");
    try {
      await memoryReembed(ctx, leadId);
      await scriptApiEndpointIds(ctx, leadId);
    } finally {
      await retireAgent(ctx, leadId);
    }
  },
};
