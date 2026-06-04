import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  countActiveScriptRuns,
  countScriptRunJournalAgentTaskSteps,
  countScriptRunJournalSteps,
  countScriptRuns,
  createScriptRun,
  createTaskExtended,
  getAgentById,
  getLatestTaskByContextKey,
  getScriptRun,
  getScriptRunByIdempotencyKey,
  getScriptRunJournalStep,
  listScriptRunJournalSteps,
  listScriptRuns,
  updateScriptRun,
  upsertScriptRunJournalStep,
} from "../be/db";
import { lintWorkflowLabels } from "../script-workflows/label-lint";
import { scriptRunMaxAgentTasks, scriptRunMaxSteps } from "../script-workflows/limits";
import {
  abortScriptRunLimit,
  startScriptRunProcess,
  terminateScriptRunProcess,
} from "../script-workflows/supervisor";
import { ScriptRunStatusSchema, TERMINAL_SCRIPT_RUN_STATUSES } from "../types";
import { getAppUrl } from "../utils/constants";
import { executeRawLlm, RawLlmConfigSchema } from "../workflows/executors/raw-llm";
import { route } from "./route-def";
import { deriveApiBaseUrl, json, jsonError } from "./utils";

const DEFAULT_SCRIPT_RUN_CONCURRENCY_CAP = 10;

const runIdParamsSchema = z.object({ runId: z.string().uuid() });
const idParamsSchema = z.object({ id: z.string().uuid() });
const stepParamsSchema = z.object({
  runId: z.string().uuid(),
  stepKey: z.string().min(1),
});

const createScriptRunBodySchema = z.object({
  source: z.string().min(1),
  args: z.unknown().optional(),
  background: z.boolean().default(true),
  idempotencyKey: z.string().min(1).max(200).optional(),
  scriptName: z.string().min(1).max(200).optional(),
  requestedByUserId: z.string().optional(),
});

const listScriptRunsQuerySchema = z.object({
  status: ScriptRunStatusSchema.optional(),
  agentId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const journalStepBodySchema = z.object({
  stepKey: z.string().min(1),
  stepType: z.string().min(1),
  config: z.unknown().optional(),
  status: z.enum(["completed", "failed"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

const statusBodySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), output: z.unknown().optional() }),
  z.object({ status: z.literal("failed"), error: z.string().optional() }),
  z.object({ status: z.literal("paused") }),
]);

const agentTaskBodySchema = z.object({
  stepKey: z.string().min(1),
  template: z.string().optional(),
  task: z.string().optional(),
  agentId: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  offerMode: z.boolean().optional(),
  dir: z.string().min(1).optional(),
  vcsRepo: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  parentTaskId: z.string().uuid().optional(),
  requestedByUserId: z.string().optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

const createScriptRunRoute = route({
  method: "post",
  path: "/api/script-runs",
  pattern: ["api", "script-runs"],
  operationId: "script_runs_create",
  summary: "Launch a durable script workflow run",
  description:
    "Foundation endpoint for Script Workflows v1. In PR 1 it persists the run and returns its dashboard URL; spawning is added by the supervisor PR.",
  tags: ["Script Runs"],
  body: createScriptRunBodySchema,
  responses: {
    201: { description: "Script run created" },
    400: { description: "Validation or label-lint failure" },
    409: { description: "Existing idempotent run returned" },
    429: { description: "Script run concurrency cap reached" },
  },
});

const listScriptRunsRoute = route({
  method: "get",
  path: "/api/script-runs",
  pattern: ["api", "script-runs"],
  operationId: "script_runs_list",
  summary: "List script workflow runs",
  tags: ["Script Runs"],
  query: listScriptRunsQuerySchema,
  responses: {
    200: { description: "Paginated script run list" },
  },
});

const getScriptRunRoute = route({
  method: "get",
  path: "/api/script-runs/{id}",
  pattern: ["api", "script-runs", null],
  operationId: "script_runs_get",
  summary: "Get a script workflow run with journal",
  tags: ["Script Runs"],
  params: idParamsSchema,
  responses: {
    200: { description: "Script run detail" },
    404: { description: "Script run not found" },
  },
});

const deleteScriptRunRoute = route({
  method: "delete",
  path: "/api/script-runs/{id}",
  pattern: ["api", "script-runs", null],
  operationId: "script_runs_cancel",
  summary: "Cancel a script workflow run",
  tags: ["Script Runs"],
  params: idParamsSchema,
  responses: {
    204: { description: "Script run cancelled" },
    404: { description: "Script run not found" },
  },
});

const getInternalStepRoute = route({
  method: "get",
  path: "/api/internal/script-runs/{runId}/steps/{stepKey}",
  pattern: ["api", "internal", "script-runs", null, "steps", null],
  operationId: "script_runs_internal_step_get",
  summary: "Get a script run journal step",
  tags: ["Script Runs"],
  params: stepParamsSchema,
  responses: {
    200: { description: "Journal step found" },
    404: { description: "Journal step not found" },
  },
});

const postInternalStepRoute = route({
  method: "post",
  path: "/api/internal/script-runs/{runId}/steps",
  pattern: ["api", "internal", "script-runs", null, "steps"],
  operationId: "script_runs_internal_step_create",
  summary: "Write a script run journal step",
  tags: ["Script Runs"],
  params: runIdParamsSchema,
  body: journalStepBodySchema,
  responses: {
    201: { description: "Journal step written" },
    404: { description: "Script run not found" },
  },
});

const heartbeatRoute = route({
  method: "post",
  path: "/api/internal/script-runs/{runId}/heartbeat",
  pattern: ["api", "internal", "script-runs", null, "heartbeat"],
  operationId: "script_runs_internal_heartbeat",
  summary: "Record a script run heartbeat",
  tags: ["Script Runs"],
  params: runIdParamsSchema,
  responses: {
    204: { description: "Heartbeat recorded" },
    404: { description: "Script run not found" },
  },
});

const statusRoute = route({
  method: "post",
  path: "/api/internal/script-runs/{runId}/status",
  pattern: ["api", "internal", "script-runs", null, "status"],
  operationId: "script_runs_internal_status",
  summary: "Update script run status from subprocess",
  tags: ["Script Runs"],
  params: runIdParamsSchema,
  body: statusBodySchema,
  responses: {
    204: { description: "Status updated" },
    404: { description: "Script run not found" },
  },
});

const rawLlmRoute = route({
  method: "post",
  path: "/api/internal/raw-llm",
  pattern: ["api", "internal", "raw-llm"],
  operationId: "script_runs_internal_raw_llm",
  summary: "Execute a raw LLM call for a script workflow",
  tags: ["Script Runs"],
  body: RawLlmConfigSchema,
  responses: {
    200: { description: "LLM call completed" },
    500: { description: "LLM call failed" },
  },
});

const agentTaskRoute = route({
  method: "post",
  path: "/api/internal/script-runs/{runId}/agent-task",
  pattern: ["api", "internal", "script-runs", null, "agent-task"],
  operationId: "script_runs_internal_agent_task",
  summary: "Create or wait for a script workflow agent task step",
  tags: ["Script Runs"],
  params: runIdParamsSchema,
  body: agentTaskBodySchema,
  responses: {
    200: { description: "Agent task completed" },
    202: { description: "Agent task created or still running" },
    404: { description: "Script run not found" },
  },
});

function requireAgent(res: ServerResponse, agentId: string | undefined) {
  if (!agentId) {
    jsonError(res, "X-Agent-ID required for script runs API", 400);
    return null;
  }
  const agent = getAgentById(agentId);
  if (!agent) {
    jsonError(res, "Agent not found", 404);
    return null;
  }
  return agent;
}

function scriptRunUrl(id: string): string {
  return `${getAppUrl()}/script-runs/${id}`;
}

function scriptRunConcurrencyCap(): number {
  const raw = process.env.SCRIPT_RUN_CONCURRENCY_CAP;
  if (!raw) return DEFAULT_SCRIPT_RUN_CONCURRENCY_CAP;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_SCRIPT_RUN_CONCURRENCY_CAP;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertRunWithinLimits(runId: string): { ok: true } | { ok: false; error: string } {
  const maxSteps = scriptRunMaxSteps();
  const stepCount = countScriptRunJournalSteps(runId);
  if (stepCount > maxSteps) {
    const error = `SCRIPT_RUN_MAX_STEPS exceeded (${stepCount}/${maxSteps})`;
    abortScriptRunLimit(runId, error);
    return { ok: false, error };
  }

  const maxAgentTasks = scriptRunMaxAgentTasks();
  const agentTaskCount = countScriptRunJournalAgentTaskSteps(runId);
  if (agentTaskCount > maxAgentTasks) {
    const error = `SCRIPT_RUN_MAX_AGENT_TASKS exceeded (${agentTaskCount}/${maxAgentTasks})`;
    abortScriptRunLimit(runId, error);
    return { ok: false, error };
  }

  return { ok: true };
}

export async function handleScriptRuns(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  agentId: string | undefined,
): Promise<boolean> {
  if (createScriptRunRoute.match(req.method, pathSegments)) {
    const parsed = await createScriptRunRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = requireAgent(res, agentId);
    if (!agent) return true;

    const lint = lintWorkflowLabels(parsed.body.source);
    if (!lint.ok) {
      json(
        res,
        {
          error: "label_lint_violation",
          message: "Launch rejected: loop step label collision detected",
          violations: lint.errors,
        },
        400,
      );
      return true;
    }

    if (parsed.body.idempotencyKey) {
      const existingRun = getScriptRunByIdempotencyKey(parsed.body.idempotencyKey);
      if (existingRun) {
        json(
          res,
          { id: existingRun.id, status: existingRun.status, url: scriptRunUrl(existingRun.id) },
          409,
        );
        return true;
      }
    }

    const cap = scriptRunConcurrencyCap();
    if (countActiveScriptRuns() >= cap) {
      json(res, { error: "script_run_concurrency_cap", cap }, 429);
      return true;
    }

    const { run, existing } = createScriptRun({
      id: crypto.randomUUID(),
      agentId: agent.id,
      source: parsed.body.source,
      args: parsed.body.args ?? null,
      scriptName: parsed.body.scriptName,
      idempotencyKey: parsed.body.idempotencyKey,
      requestedByUserId: parsed.body.requestedByUserId,
      createdBy: parsed.body.requestedByUserId,
    });

    if (!existing && parsed.body.background) {
      startScriptRunProcess(run, deriveApiBaseUrl(req), bearerToken(req)).catch((err) => {
        updateScriptRun(run.id, {
          status: "failed",
          pid: null,
          finishedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    json(res, { id: run.id, status: run.status, url: scriptRunUrl(run.id) }, existing ? 409 : 201);
    return true;
  }

  if (listScriptRunsRoute.match(req.method, pathSegments)) {
    const parsed = await listScriptRunsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const opts = {
      status: parsed.query.status,
      agentId: parsed.query.agentId,
      limit: parsed.query.limit ?? 50,
      offset: parsed.query.offset ?? 0,
    };
    json(res, {
      runs: listScriptRuns(opts),
      total: countScriptRuns({ status: opts.status, agentId: opts.agentId }),
    });
    return true;
  }

  if (getScriptRunRoute.match(req.method, pathSegments)) {
    const parsed = await getScriptRunRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const run = getScriptRun(parsed.params.id);
    if (!run) {
      jsonError(res, "Script run not found", 404);
      return true;
    }
    json(res, { run, journal: listScriptRunJournalSteps(run.id) });
    return true;
  }

  if (deleteScriptRunRoute.match(req.method, pathSegments)) {
    const parsed = await deleteScriptRunRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const run = getScriptRun(parsed.params.id);
    if (!run) {
      jsonError(res, "Script run not found", 404);
      return true;
    }
    terminateScriptRunProcess(run.id);
    updateScriptRun(run.id, {
      status: "cancelled",
      pid: null,
      finishedAt: new Date().toISOString(),
    });
    res.writeHead(204);
    res.end();
    return true;
  }

  if (getInternalStepRoute.match(req.method, pathSegments)) {
    const parsed = await getInternalStepRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const step = getScriptRunJournalStep(parsed.params.runId, parsed.params.stepKey);
    if (!step) {
      jsonError(res, "Script run journal step not found", 404);
      return true;
    }
    json(res, { stepKey: step.stepKey, stepType: step.stepType, result: step.result });
    return true;
  }

  if (postInternalStepRoute.match(req.method, pathSegments)) {
    const parsed = await postInternalStepRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const run = getScriptRun(parsed.params.runId);
    if (!run) {
      jsonError(res, "Script run not found", 404);
      return true;
    }
    upsertScriptRunJournalStep({
      runId: run.id,
      stepKey: parsed.body.stepKey,
      stepType: parsed.body.stepType,
      config: parsed.body.config ?? {},
      status: parsed.body.status,
      result: parsed.body.result,
      error: parsed.body.error,
    });
    const limit = assertRunWithinLimits(run.id);
    if (!limit.ok) {
      json(res, { error: "script_run_limit", message: limit.error }, 429);
      return true;
    }
    json(res, { ok: true }, 201);
    return true;
  }

  if (heartbeatRoute.match(req.method, pathSegments)) {
    const parsed = await heartbeatRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!getScriptRun(parsed.params.runId)) {
      jsonError(res, "Script run not found", 404);
      return true;
    }
    updateScriptRun(parsed.params.runId, { lastHeartbeatAt: new Date().toISOString() });
    res.writeHead(204);
    res.end();
    return true;
  }

  if (statusRoute.match(req.method, pathSegments)) {
    const parsed = await statusRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const run = getScriptRun(parsed.params.runId);
    if (!run) {
      jsonError(res, "Script run not found", 404);
      return true;
    }
    if (TERMINAL_SCRIPT_RUN_STATUSES.some((status) => status === run.status)) {
      res.writeHead(204);
      res.end();
      return true;
    }
    updateScriptRun(parsed.params.runId, {
      status: parsed.body.status,
      pid: null,
      finishedAt: parsed.body.status === "paused" ? null : new Date().toISOString(),
      output: "output" in parsed.body ? parsed.body.output : undefined,
      error: "error" in parsed.body ? (parsed.body.error ?? null) : undefined,
    });
    res.writeHead(204);
    res.end();
    return true;
  }

  if (rawLlmRoute.match(req.method, pathSegments)) {
    const parsed = await rawLlmRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const result = await executeRawLlm(parsed.body);
    if (result.status === "failed") {
      json(res, { error: result.error }, 500);
      return true;
    }
    json(res, result.output);
    return true;
  }

  if (agentTaskRoute.match(req.method, pathSegments)) {
    const parsed = await agentTaskRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const run = getScriptRun(parsed.params.runId);
    if (!run) {
      jsonError(res, "Script run not found", 404);
      return true;
    }

    const contextKey = `script-run:${run.id}:${parsed.body.stepKey}`;
    let task = getLatestTaskByContextKey(contextKey);
    if (!task) {
      task = createTaskExtended(parsed.body.template ?? parsed.body.task ?? parsed.body.stepKey, {
        agentId: parsed.body.agentId,
        tags: parsed.body.tags,
        priority: parsed.body.priority,
        offeredTo: parsed.body.offerMode ? parsed.body.agentId : undefined,
        taskType: "script-run-step",
        source: "mcp",
        dir: parsed.body.dir,
        vcsRepo: parsed.body.vcsRepo,
        model: parsed.body.model,
        parentTaskId: parsed.body.parentTaskId,
        requestedByUserId: parsed.body.requestedByUserId ?? run.requestedByUserId,
        outputSchema: parsed.body.outputSchema,
        contextKey,
      });
    }

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const latest = getLatestTaskByContextKey(contextKey) ?? task;
      if (latest.status === "completed") {
        json(res, { taskId: latest.id, taskOutput: latest.output ?? null });
        return true;
      }
      if (
        latest.status === "failed" ||
        latest.status === "cancelled" ||
        latest.status === "superseded"
      ) {
        json(res, { error: `Agent task ${latest.status}`, taskId: latest.id }, 409);
        return true;
      }
      await sleep(1000);
    }

    json(res, { taskId: task.id, status: task.status }, 202);
    return true;
  }

  return false;
}
