// Shared helpers for the knowledge-* scenarios (memory, skills, prompt templates, pages,
// assets, apps, rooms, comb). Black box: HTTP, MCP, the operator key and agent ids only.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import { calledMcpTools } from "../mcp";
import type { ScenarioContext } from "../run";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type McpSession = Awaited<ReturnType<ScenarioContext["connectMcp"]>>;

/** A tool result reduced to what the scenarios assert on. */
export type ToolOutcome = {
  isError: boolean;
  text: string;
  /** `structuredContent`: the envelope (`success`, `message`, `details`) plus the tool's data keys. */
  data: Record<string, unknown>;
  message: string;
};

export async function callTool(
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const result = asRecord(await session.callTool(name, args));
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((item) => {
      const record = asRecord(item);
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
    data,
    message: typeof data.message === "string" ? data.message : "",
  };
}

export function expectToolOk(outcome: ToolOutcome, label: string): ToolOutcome {
  expect(
    !outcome.isError && outcome.data.success !== false,
    `${label}: tool returned an error: ${outcome.message || outcome.text.slice(0, 300)}`,
  );
  expect(outcome.message.length > 0, `${label}: structured message is empty`);
  expect(outcome.text.includes(outcome.message), `${label}: text channel lacks the message`);
  return outcome;
}

export function expectToolError(
  outcome: ToolOutcome,
  label: string,
  pattern?: RegExp | string,
): ToolOutcome {
  expect(outcome.isError, `${label}: expected a tool error, got ok: ${outcome.message}`);
  expect(outcome.data.success === false, `${label}: error result has success !== false`);
  if (pattern !== undefined) {
    const haystack = `${outcome.message}\n${outcome.text}`;
    const matches =
      typeof pattern === "string" ? haystack.includes(pattern) : pattern.test(haystack);
    expect(matches, `${label}: error did not match ${String(pattern)}: ${haystack.slice(0, 300)}`);
  }
  return outcome;
}

/**
 * An MCP session bound to a task (`X-Source-Task-ID`), which `memory_rate` needs. The shared
 * `ctx.connectMcp` cannot send extra headers, so this builds the SDK client itself and records
 * each call in the runner's tool coverage set.
 */
export async function connectTaskMcp(
  ctx: ScenarioContext,
  agentId: string,
  taskId: string,
): Promise<McpSession> {
  const client = new Client({ name: "agent-swarm-e2e-task", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        "X-Agent-ID": agentId,
        "X-Source-Task-ID": taskId,
      },
    },
  });
  await client.connect(transport);
  return {
    async listTools() {
      const result = await client.listTools();
      return result.tools;
    },
    async callTool(name: string, args: Record<string, unknown>) {
      (calledMcpTools() as Set<string>).add(name);
      return client.callTool({ name, arguments: args });
    },
    async close() {
      await client.close();
    },
  };
}

export async function registerAgent(
  ctx: ScenarioContext,
  label: string,
  options: { lead?: boolean } = {},
): Promise<string> {
  const response = await ctx.api("POST", "/api/agents", {
    body: {
      name: `e2e-kn-${label}-${ctx.nonce}`,
      role: options.lead ? "lead" : "worker",
      isLead: options.lead === true,
      status: "online",
    },
  });
  expectStatus(response, [201], `register ${label} agent`);
  const id = asRecord(response.json).id;
  expect(typeof id === "string" && UUID.test(id), `${label} agent id is not a UUID`);
  return id;
}

const leadByRun = new Map<string, string>();

/**
 * One dedicated lead per run, shared by the knowledge scenarios. A lead changes routing for the
 * scenarios that follow, so it is registered lazily and only once.
 */
export async function ensureLead(ctx: ScenarioContext): Promise<string> {
  const known = leadByRun.get(ctx.baseUrl);
  if (known) return known;
  const id = await registerAgent(ctx, "lead", { lead: true });
  leadByRun.set(ctx.baseUrl, id);
  return id;
}

/** A task pinned to an agent, so no pool poller can take it. Returns the task id. */
export async function createPinnedTask(
  ctx: ScenarioContext,
  agentId: string,
  label: string,
): Promise<string> {
  const response = await ctx.api("POST", "/api/tasks", {
    body: {
      task: `${label} ${ctx.nonce}`,
      agentId,
      routingReason: "human_pinned",
      source: "api",
    },
  });
  expectStatus(response, [201], `create pinned task (${label})`);
  const id = asRecord(response.json).id;
  expect(typeof id === "string" && UUID.test(id), `${label} task id is not a UUID`);
  return id;
}

export async function cancelTask(ctx: ScenarioContext, taskId: string): Promise<void> {
  const response = await ctx.api("POST", `/api/tasks/${taskId}/cancel`, {
    body: { reason: "knowledge e2e cleanup" },
  });
  expectStatus(response, [200], "cancel helper task");
}

export function dbCount(ctx: ScenarioContext, sql: string, params: (string | number)[]): number {
  const row = ctx.db.get<{ n: number }>(sql, params);
  return row?.n ?? 0;
}

export { pollUntil };
