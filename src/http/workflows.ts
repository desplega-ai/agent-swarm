import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  listWorkflowRuns,
  listWorkflows,
  updateWorkflow,
} from "../be/db";
import { WorkflowDefinitionSchema } from "../types";
import { startWorkflowExecution } from "../workflows";
import { retryFailedRun } from "../workflows/resume";
import { route } from "./route-def";
import { json, jsonError, parseBody } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listWorkflowsRoute = route({
  method: "get",
  path: "/api/workflows",
  pattern: ["api", "workflows"],
  summary: "List all workflows",
  tags: ["Workflows"],
  responses: {
    200: { description: "Workflow list" },
  },
});

const createWorkflowRoute = route({
  method: "post",
  path: "/api/workflows",
  pattern: ["api", "workflows"],
  summary: "Create a new workflow",
  tags: ["Workflows"],
  body: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    definition: z.record(z.string(), z.unknown()),
  }),
  responses: {
    201: { description: "Workflow created" },
    400: { description: "Invalid definition" },
  },
});

const getWorkflowRoute = route({
  method: "get",
  path: "/api/workflows/{id}",
  pattern: ["api", "workflows", null],
  summary: "Get a workflow by ID",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Workflow details" },
    404: { description: "Workflow not found" },
  },
});

const updateWorkflowRoute = route({
  method: "put",
  path: "/api/workflows/{id}",
  pattern: ["api", "workflows", null],
  summary: "Update a workflow",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  body: z.record(z.string(), z.unknown()),
  responses: {
    200: { description: "Workflow updated" },
    400: { description: "Invalid definition" },
    404: { description: "Workflow not found" },
  },
});

const deleteWorkflowRoute = route({
  method: "delete",
  path: "/api/workflows/{id}",
  pattern: ["api", "workflows", null],
  summary: "Delete a workflow",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  responses: {
    204: { description: "Workflow deleted" },
    404: { description: "Workflow not found" },
  },
});

const triggerWorkflow = route({
  method: "post",
  path: "/api/workflows/{id}/trigger",
  pattern: ["api", "workflows", null, "trigger"],
  summary: "Trigger a workflow execution",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  responses: {
    201: { description: "Workflow run started" },
    400: { description: "Workflow is disabled" },
    401: { description: "Unauthorized" },
    404: { description: "Workflow not found" },
  },
});

const listWorkflowRunsRoute = route({
  method: "get",
  path: "/api/workflows/{id}/runs",
  pattern: ["api", "workflows", null, "runs"],
  summary: "List runs for a workflow",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Workflow run list" },
  },
});

const getWorkflowRunRoute = route({
  method: "get",
  path: "/api/workflow-runs/{id}",
  pattern: ["api", "workflow-runs", null],
  summary: "Get a workflow run with steps",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Workflow run details with steps" },
    404: { description: "Run not found" },
  },
});

const retryWorkflowRun = route({
  method: "post",
  path: "/api/workflow-runs/{id}/retry",
  pattern: ["api", "workflow-runs", null, "retry"],
  summary: "Retry a failed workflow run",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Retry started" },
    400: { description: "Cannot retry" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleWorkflows(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (listWorkflowsRoute.match(req.method, pathSegments)) {
    const workflows = listWorkflows();
    json(res, workflows);
    return true;
  }

  if (createWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await createWorkflowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const defParsed = WorkflowDefinitionSchema.safeParse(parsed.body.definition);
    if (!defParsed.success) {
      jsonError(res, `Invalid definition: ${JSON.stringify(defParsed.error.issues)}`, 400);
      return true;
    }
    const workflow = createWorkflow({
      name: parsed.body.name,
      description: parsed.body.description,
      definition: defParsed.data,
      createdByAgentId: myAgentId ?? undefined,
    });
    json(res, workflow, 201);
    return true;
  }

  if (getWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await getWorkflowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const workflow = getWorkflow(parsed.params.id);
    if (!workflow) {
      res.writeHead(404);
      res.end();
      return true;
    }
    json(res, workflow);
    return true;
  }

  if (updateWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await updateWorkflowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const body = parsed.body as Record<string, unknown>;
    if (body.definition) {
      const defParsed = WorkflowDefinitionSchema.safeParse(body.definition);
      if (!defParsed.success) {
        jsonError(res, `Invalid definition: ${JSON.stringify(defParsed.error.issues)}`, 400);
        return true;
      }
      body.definition = defParsed.data;
    }
    const workflow = updateWorkflow(parsed.params.id, body);
    if (!workflow) {
      res.writeHead(404);
      res.end();
      return true;
    }
    json(res, workflow);
    return true;
  }

  if (deleteWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await deleteWorkflowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    try {
      const deleted = deleteWorkflow(parsed.params.id);
      res.writeHead(deleted ? 204 : 404);
    } catch (err) {
      jsonError(res, String(err), 500);
      return true;
    }
    res.end();
    return true;
  }

  if (triggerWorkflow.match(req.method, pathSegments)) {
    const parsed = await triggerWorkflow.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const workflow = getWorkflow(parsed.params.id);
    if (!workflow) {
      res.writeHead(404);
      res.end();
      return true;
    }
    if (!workflow.enabled) {
      jsonError(res, "Workflow is disabled", 400);
      return true;
    }
    const secret = queryParams.get("secret");
    if (!myAgentId && secret !== workflow.webhookSecret) {
      res.writeHead(401);
      res.end();
      return true;
    }
    const body = await parseBody<Record<string, unknown>>(req);
    const runId = await startWorkflowExecution(workflow, body);
    json(res, { runId }, 201);
    return true;
  }

  if (listWorkflowRunsRoute.match(req.method, pathSegments)) {
    const parsed = await listWorkflowRunsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const runs = listWorkflowRuns(parsed.params.id);
    json(res, runs);
    return true;
  }

  if (getWorkflowRunRoute.match(req.method, pathSegments)) {
    const parsed = await getWorkflowRunRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const run = getWorkflowRun(parsed.params.id);
    if (!run) {
      res.writeHead(404);
      res.end();
      return true;
    }
    const steps = getWorkflowRunStepsByRunId(parsed.params.id);
    json(res, { ...run, steps });
    return true;
  }

  if (retryWorkflowRun.match(req.method, pathSegments)) {
    const parsed = await retryWorkflowRun.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    try {
      await retryFailedRun(parsed.params.id);
      json(res, { success: true });
    } catch (err) {
      jsonError(res, String(err), 400);
    }
    return true;
  }

  return false;
}
