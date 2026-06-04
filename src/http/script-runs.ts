import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  countActiveScriptRuns,
  countScriptRuns,
  createScriptRun,
  getAgentById,
  getScriptRun,
  getScriptRunByIdempotencyKey,
  getScriptRunJournalStep,
  listScriptRunJournalSteps,
  listScriptRuns,
  updateScriptRun,
  upsertScriptRunJournalStep,
} from "../be/db";
import { lintWorkflowLabels } from "../script-workflows/label-lint";
import { ScriptRunStatusSchema } from "../types";
import { getAppUrl } from "../utils/constants";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

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
    if (!getScriptRun(parsed.params.runId)) {
      jsonError(res, "Script run not found", 404);
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

  return false;
}
