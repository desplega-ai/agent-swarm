// Shared helpers for the workflow-* scenarios (definitions, engine, approvals,
// schedules). Not a scenario: listed in NON_SCENARIO_FILES in registry.ts.
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { McpConnection } from "../mcp";
import type { ScenarioContext } from "../run";

/** The shared "general" channel every swarm is seeded with. */
export const GENERAL_CHANNEL_ID = "00000000-0000-4000-8000-000000000001";

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "skipped"];

export type WorkflowNodeDef = {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next?: string | string[] | Record<string, string>;
  inputs?: Record<string, string>;
  label?: string;
  retry?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export type WorkflowDef = { nodes: WorkflowNodeDef[]; onNodeFailure?: "fail" | "continue" };

export type RunDetail = {
  run: Record<string, unknown>;
  steps: Record<string, unknown>[];
  parent?: Record<string, unknown>;
};

/** A registered, online worker agent. */
export async function registerWorker(ctx: ScenarioContext, name: string): Promise<string> {
  const response = await ctx.api("POST", "/api/agents", {
    body: { name: `${name}-${ctx.nonce}`, role: "worker", status: "online" },
  });
  expectStatus(response, [201], `register worker ${name}`);
  return asString(asRecord(response.json).id, `worker ${name} id`);
}

/** POST /api/workflows, returning the workflow id. */
export async function createWorkflow(
  ctx: ScenarioContext,
  name: string,
  definition: WorkflowDef,
  extra: Record<string, unknown> = {},
  agentId?: string,
): Promise<string> {
  const response = await ctx.api("POST", "/api/workflows", {
    agentId,
    body: { name: `${name}-${ctx.nonce}`, definition, ...extra },
  });
  expectStatus(response, [201], `create workflow ${name}`);
  return asString(asRecord(response.json).id, `workflow ${name} id`);
}

/** POST /api/workflows/{id}/trigger, returning the run id. */
export async function triggerWorkflow(
  ctx: ScenarioContext,
  workflowId: string,
  body: Record<string, unknown> = {},
  options: { agentId?: string; headers?: Record<string, string>; wait?: boolean } = {},
): Promise<{ runId: string; skipped: boolean }> {
  const query = options.wait === false ? "?wait=false" : "";
  const response = await ctx.api("POST", `/api/workflows/${workflowId}/trigger${query}`, {
    body,
    agentId: options.agentId,
    headers: options.headers,
  });
  expectStatus(response, [201], `trigger workflow ${workflowId}`);
  const json = asRecord(response.json);
  expect(typeof json.skipped === "boolean", "trigger response has a boolean `skipped`");
  return { runId: asString(json.runId, "trigger runId"), skipped: json.skipped };
}

export async function getRunDetail(ctx: ScenarioContext, runId: string): Promise<RunDetail> {
  const response = await ctx.api("GET", `/api/workflow-runs/${runId}`);
  expectStatus(response, [200], `get workflow run ${runId}`);
  const json = asRecord(response.json);
  return {
    run: asRecord(json.run),
    steps: asRecords(json, "steps"),
    parent: json.parent === undefined ? undefined : asRecord(json.parent),
  };
}

function describeRun(detail: RunDetail): string {
  const steps = detail.steps
    .map(
      (step) =>
        `${String(step.nodeId)}:${String(step.status)}${step.error ? `(${String(step.error).slice(0, 160)})` : ""}`,
    )
    .join(", ");
  return `run ${String(detail.run.status)}${detail.run.error ? ` error=${String(detail.run.error).slice(0, 200)}` : ""} steps=[${steps}]`;
}

/** Poll until the run is in one of `wanted` statuses, or throw with the run's state. */
export async function waitForRun(
  ctx: ScenarioContext,
  runId: string,
  wanted: string | string[],
  timeoutMs = 30_000,
  label = "workflow run",
): Promise<RunDetail> {
  const statuses = Array.isArray(wanted) ? wanted : [wanted];
  let detail: RunDetail | undefined;
  const reached = await pollUntil(
    async () => {
      detail = await getRunDetail(ctx, runId);
      return statuses.includes(String(detail.run.status));
    },
    timeoutMs,
    250,
  );
  expect(
    reached && detail,
    `${label} ${runId} never reached ${statuses.join("|")} within ${timeoutMs}ms: ${detail ? describeRun(detail) : "no detail"}`,
  );
  return detail;
}

/** Wait for a terminal run and require one specific terminal status. */
export async function expectRunStatus(
  ctx: ScenarioContext,
  runId: string,
  status: string,
  timeoutMs = 30_000,
  label = "workflow run",
): Promise<RunDetail> {
  const detail = await waitForRun(ctx, runId, status, timeoutMs, label);
  return detail;
}

/** Poll until one step of the run reaches `status`. */
export async function waitForStep(
  ctx: ScenarioContext,
  runId: string,
  nodeId: string,
  status: string | string[],
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const wanted = Array.isArray(status) ? status : [status];
  let found: Record<string, unknown> | undefined;
  let detail: RunDetail | undefined;
  const reached = await pollUntil(
    async () => {
      detail = await getRunDetail(ctx, runId);
      found = detail.steps.find((step) => step.nodeId === nodeId);
      return found !== undefined && wanted.includes(String(found.status));
    },
    timeoutMs,
    250,
  );
  expect(
    reached && found,
    `step ${nodeId} of run ${runId} never reached ${wanted.join("|")} within ${timeoutMs}ms: ${detail ? describeRun(detail) : "no detail"}`,
  );
  return found;
}

export function stepOf(detail: RunDetail, nodeId: string): Record<string, unknown> {
  const step = detail.steps.find((candidate) => candidate.nodeId === nodeId);
  expect(step, `run has no step for node ${nodeId}: ${describeRun(detail)}`);
  return step;
}

/** The parsed output object of one step. */
export function outputOf(detail: RunDetail, nodeId: string): Record<string, unknown> {
  const step = stepOf(detail, nodeId);
  expect(
    step.status === "completed",
    `step ${nodeId} is ${String(step.status)}, not completed: ${String(step.error ?? "")}`,
  );
  return asRecord(step.output);
}

export function hasStep(detail: RunDetail, nodeId: string): boolean {
  return detail.steps.some((step) => step.nodeId === nodeId);
}

export type ToolOutcome = {
  isError: boolean;
  text: string;
  structured: Record<string, unknown>;
};

/** Call an MCP tool and flatten its result into text and structured content. */
export async function callTool(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const result = asRecord(await connection.callTool(name, args));
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((item) => {
      const record = asRecord(item);
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("\n");
  const structured =
    typeof result.structuredContent === "object" && result.structuredContent !== null
      ? (result.structuredContent as Record<string, unknown>)
      : {};
  return { isError: result.isError === true, text, structured };
}

/** Call a tool that must succeed. */
export async function callToolOk(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const outcome = await callTool(connection, name, args);
  expect(!outcome.isError, `${name} returned isError: ${outcome.text.slice(0, 400)}`);
  expect(outcome.structured.success === true, `${name} structuredContent.success is not true`);
  expect(
    typeof outcome.structured.message === "string" && outcome.structured.message.length > 0,
    `${name} returned no structured message`,
  );
  return outcome;
}

/** Call a tool that must fail, and return the failure. */
export async function callToolErr(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown>,
  expectedText?: string,
): Promise<ToolOutcome> {
  const outcome = await callTool(connection, name, args);
  expect(
    outcome.isError,
    `${name} was expected to fail but succeeded: ${outcome.text.slice(0, 300)}`,
  );
  expect(outcome.structured.success === false, `${name} structuredContent.success is not false`);
  if (expectedText) {
    expect(
      outcome.text.includes(expectedText),
      `${name} error does not mention "${expectedText}": ${outcome.text.slice(0, 300)}`,
    );
  }
  return outcome;
}

/** Remove a workflow, ignoring a 404 (the scenario may already have deleted it). */
export async function deleteWorkflowQuietly(ctx: ScenarioContext, id: string): Promise<void> {
  await ctx.api("DELETE", `/api/workflows/${id}`);
}

/** Set a global config row and return a cleanup function that deletes it. */
export async function setGlobalConfig(
  ctx: ScenarioContext,
  key: string,
  value: string,
  isSecret = false,
): Promise<() => Promise<void>> {
  const response = await ctx.api("PUT", "/api/config", {
    body: { scope: "global", key, value, isSecret },
  });
  expectStatus(response, [200, 201], `set global config ${key}`);
  const id = asString(asRecord(response.json).id, `config ${key} id`);
  return async () => {
    await ctx.api("DELETE", `/api/config/${id}`);
  };
}

/**
 * Point the `laya` SystemOne provider at the mock inference host. Returns the cleanup
 * that deletes both rows.
 */
export async function pointLayaAtMock(ctx: ScenarioContext): Promise<() => Promise<void>> {
  const dropUrl = await setGlobalConfig(ctx, "LAYA_URL", ctx.llm.origin);
  const dropKey = await setGlobalConfig(ctx, "LAYA_API_KEY", "e2e-laya-key", true);
  return async () => {
    await dropKey();
    await dropUrl();
  };
}

type QuestionSpec = { type?: unknown; criteria?: unknown };

export type SystemOnePick = {
  /** Choice answer per question id (default: the first option). */
  choice?: Record<string, string>;
  /** Noul probability per question id (default 0.9). */
  noul?: Record<string, number>;
  /** Top-probability confidence per choice/score question id (default 0.9). */
  confidence?: Record<string, number>;
  /** Score per question id (default 0). */
  score?: Record<string, number>;
};

/**
 * A SystemOne response that satisfies the node's validator for every question in the
 * request body: probabilities that sum to 1, a legend per score level, and
 * `answer_confidence` next to `confidence` (laya reads the former).
 */
export function systemOneDecisionAnswer(
  body: Record<string, unknown>,
  pick: SystemOnePick = {},
): Record<string, unknown> {
  const questions = asRecord(body.questions ?? {});
  const answers: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(questions)) {
    const spec = asRecord(raw) as QuestionSpec;
    const confidence = pick.confidence?.[id] ?? 0.9;
    if (spec.type === "noul") {
      answers[id] = { type: "noul", noul: pick.noul?.[id] ?? 0.9 };
    } else if (spec.type === "choice") {
      const options = Object.keys(asRecord(spec.criteria));
      const chosen = pick.choice?.[id] ?? options[0];
      const rest = (1 - confidence) / Math.max(1, options.length - 1);
      answers[id] = {
        type: "choice",
        choice: chosen,
        confidence,
        answer_confidence: confidence,
        probabilities: Object.fromEntries(
          options.map((option) => [option, option === chosen ? confidence : rest]),
        ),
      };
    } else {
      const levels = Array.isArray(spec.criteria) ? spec.criteria : [];
      const top = Math.round(pick.score?.[id] ?? 0);
      const rest = (1 - confidence) / Math.max(1, levels.length - 1);
      answers[id] = {
        type: "score",
        score: pick.score?.[id] ?? 0,
        confidence,
        answer_confidence: confidence,
        legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
        probabilities: Object.fromEntries(
          levels.map((_, index) => [String(index), index === top ? confidence : rest]),
        ),
      };
    }
  }
  return {
    model: "laya-rl-agent",
    routing: { model: "english" },
    answers,
    usage: { input_tokens: 12, output_tokens: 0 },
  };
}

/** Find the approval requests a workflow run created. */
export async function approvalsForRun(
  ctx: ScenarioContext,
  runId: string,
  status?: string,
): Promise<Record<string, unknown>[]> {
  const query = new URLSearchParams({ workflowRunId: runId });
  if (status) query.set("status", status);
  const response = await ctx.api("GET", `/api/approval-requests?${query}`);
  expectStatus(response, [200], "list approval requests for a run");
  return asRecords(response.json, "approvalRequests");
}

/** Wait for the run's pending approval request and return it. */
export async function waitForApproval(
  ctx: ScenarioContext,
  runId: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  const reached = await pollUntil(
    async () => {
      found = (await approvalsForRun(ctx, runId, "pending"))[0];
      return found !== undefined;
    },
    timeoutMs,
    250,
  );
  expect(reached && found, `run ${runId} never raised a pending approval request`);
  return found;
}

/** Answer every question of a request with an approval (or a rejection), as the operator. */
export async function respondApproval(
  ctx: ScenarioContext,
  requestId: string,
  responses: Record<string, unknown>,
  expectedStatus = 200,
): Promise<Record<string, unknown>> {
  const response = await ctx.api("POST", `/api/approval-requests/${requestId}/respond`, {
    body: { responses, respondedBy: "e2e-operator" },
  });
  expectStatus(response, [expectedStatus], `respond to approval ${requestId}`);
  return asRecord(response.json);
}
