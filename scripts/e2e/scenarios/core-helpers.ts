// Shared fixtures for the core-* scenarios (agents, tasks, sessions, telemetry, messaging).
// Black box: HTTP and MCP only, plus the read-only ctx.db handle for assertions.
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { McpConnection } from "../mcp";
import type { ScenarioContext } from "../run";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ToolOutcome = {
  isError: boolean;
  /** Every text block of the result, joined. */
  text: string;
  /** `structuredContent.message`, or "" when the result has no structured content. */
  message: string;
  /** The whole `structuredContent` object ({} when absent). */
  data: Record<string, unknown>;
};

/** Call an MCP tool and flatten the result. Never throws on `isError`. */
export async function callTool(
  conn: McpConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const result = asRecord(await conn.callTool(name, args));
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((block) => {
      const record = asRecord(block);
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("\n");
  const data =
    typeof result.structuredContent === "object" && result.structuredContent !== null
      ? (result.structuredContent as Record<string, unknown>)
      : {};
  return {
    isError: result.isError === true,
    text,
    message: typeof data.message === "string" ? data.message : "",
    data,
  };
}

/** Call a tool that must succeed. Checks both result channels agree. */
export async function expectToolOk(
  conn: McpConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const outcome = await callTool(conn, name, args);
  expect(!outcome.isError, `${name} returned isError: ${outcome.text.slice(0, 300)}`);
  expect(outcome.message.length > 0, `${name} returned no structured message`);
  expect(outcome.data.success === true, `${name} structuredContent.success is not true`);
  expect(
    outcome.text.includes(outcome.message),
    `${name} text channel does not carry the structured message "${outcome.message}"`,
  );
  return outcome;
}

/** Call a tool that must be refused. `includes` must appear in the message or text. */
export async function expectToolError(
  conn: McpConnection,
  name: string,
  args: Record<string, unknown>,
  includes: string,
): Promise<ToolOutcome> {
  const outcome = await callTool(conn, name, args);
  expect(
    outcome.isError,
    `${name} should have returned isError, got: ${outcome.text.slice(0, 300)}`,
  );
  expect(
    outcome.text.includes(includes) || outcome.message.includes(includes),
    `${name} error does not mention "${includes}": ${outcome.text.slice(0, 300)}`,
  );
  return outcome;
}

/** Open an MCP session as `agentId`, run `fn`, always close it. */
export async function withMcp<T>(
  ctx: ScenarioContext,
  agentId: string,
  fn: (conn: McpConnection) => Promise<T>,
): Promise<T> {
  const conn = await ctx.connectMcp(agentId);
  try {
    return await fn(conn);
  } finally {
    await conn.close();
  }
}

export async function registerWorker(
  ctx: ScenarioContext,
  label: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const name = `core-${label}-${ctx.nonce}`;
  const response = await ctx.api("POST", "/api/agents", {
    body: { name, role: "worker", status: "online", ...extra },
  });
  expectStatus(response, [201], `register worker ${name}`);
  const id = asRecord(response.json).id;
  expect(typeof id === "string", `Worker ${name} has no id`);
  return id;
}

/**
 * A lead named so that it sorts before any other lead: `getLeadAgent()` picks the first
 * non-offline lead by name, and the Slack scenarios leave `e2e-lead-*` agents behind.
 * Call `retireAgent` when the scenario no longer needs it.
 */
export async function registerLead(ctx: ScenarioContext, label: string): Promise<string> {
  const name = `00-core-lead-${label}-${ctx.nonce}`;
  const response = await ctx.api("POST", "/api/agents", { body: { name, isLead: true } });
  expectStatus(response, [201], `register lead ${name}`);
  const agent = asRecord(response.json);
  expect(agent.isLead === true, `Lead ${name} was not registered as a lead`);
  expect(typeof agent.id === "string", `Lead ${name} has no id`);
  return agent.id;
}

/** `POST /close` marks the agent offline so it stops attracting routing. */
export async function retireAgent(ctx: ScenarioContext, agentId: string): Promise<void> {
  expectStatus(
    await ctx.api("POST", "/close", { agentId, body: {} }),
    [204],
    `close agent ${agentId}`,
  );
}

export async function createUser(ctx: ScenarioContext, label: string): Promise<string> {
  const response = await ctx.api("POST", "/api/users", {
    body: { name: `Core ${label} ${ctx.nonce}`, status: "active" },
  });
  expectStatus(response, [200], `create user ${label}`);
  const id = asRecord(asRecord(response.json).user).id;
  expect(typeof id === "string" && id.length > 0, `User ${label} has no id`);
  return id;
}

/** Headers that make the operator key act as this dashboard user. */
export function asUser(userId: string): Record<string, string> {
  return { "X-Swarm-User-Id": userId };
}

/** Create a task assigned to `agentId` (no lead routing involved). Returns the task id. */
export async function createAssignedTask(
  ctx: ScenarioContext,
  agentId: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await ctx.api("POST", "/api/tasks", {
    body: { task: text, agentId, routingReason: "human_pinned", source: "api", ...extra },
  });
  expectStatus(response, [201], `create task "${text.slice(0, 40)}"`);
  const task = asRecord(response.json);
  expect(typeof task.id === "string" && UUID.test(task.id), "Created task id is not a UUID");
  return task.id;
}

export async function readTask(
  ctx: ScenarioContext,
  taskId: string,
): Promise<Record<string, unknown>> {
  const response = await ctx.api("GET", `/api/tasks/${taskId}`);
  expectStatus(response, [200], `read task ${taskId}`);
  return asRecord(response.json);
}

/**
 * Hand-poll as `agentId` until it is dispatched `taskId` (the task moves to in_progress).
 * Use for agents that are not driven by `ctx.startAgent`.
 */
export async function claimTask(
  ctx: ScenarioContext,
  agentId: string,
  taskId: string,
): Promise<Record<string, unknown>> {
  const claimed = await pollUntil(async () => {
    const response = await ctx.api("GET", "/api/poll", { agentId });
    expectStatus(response, [200], `poll as ${agentId}`);
    const trigger = asRecord(response.json).trigger;
    return (
      typeof trigger === "object" &&
      trigger !== null &&
      (trigger as Record<string, unknown>).taskId === taskId
    );
  }, 15_000);
  expect(claimed, `Agent ${agentId} was never dispatched task ${taskId}`);
  const task = await readTask(ctx, taskId);
  expect(task.status === "in_progress", `Task ${taskId} is ${String(task.status)} after dispatch`);
  return task;
}

/** Cancel a task a scenario leaves behind so it cannot feed a later scenario's pollers. */
export async function cancelQuietly(ctx: ScenarioContext, taskId: string): Promise<void> {
  const task = await readTask(ctx, taskId);
  if (["completed", "failed", "cancelled", "superseded"].includes(String(task.status))) return;
  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/cancel`, { body: { reason: "core e2e cleanup" } }),
    [200],
    `cancel leftover task ${taskId}`,
  );
}

/** Rows of an `{ <field>: [...] }` response as records. */
export function listOf(value: unknown, field: string): Record<string, unknown>[] {
  const list = asRecord(value)[field];
  expect(Array.isArray(list), `Expected ${field} to be an array`);
  return list.map(asRecord);
}
