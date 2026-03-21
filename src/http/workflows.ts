import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  getWorkflowVersion,
  getWorkflowVersions,
  listWorkflowRuns,
  listWorkflows,
  updateWorkflow,
} from "../be/db";
import {
  CooldownConfigSchema,
  InputValueSchema,
  TriggerConfigSchema,
  WorkflowDefinitionSchema,
  WorkflowRunStatusSchema,
} from "../types";
import { getExecutorRegistry, startWorkflowExecution } from "../workflows";
import { generateEdges, validateDefinition } from "../workflows/definition";
import { TriggerSchemaError } from "../workflows/engine";
import { retryFailedRun } from "../workflows/resume";
import { handleWebhookTrigger, WebhookError } from "../workflows/triggers";
import { snapshotWorkflow } from "../workflows/version";
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
    definition: WorkflowDefinitionSchema,
    triggers: z.array(TriggerConfigSchema).optional(),
    cooldown: CooldownConfigSchema.optional(),
    input: z.record(z.string(), InputValueSchema).optional(),
    triggerSchema: z.record(z.string(), z.unknown()).optional(),
    dir: z.string().min(1).startsWith("/").optional(),
    vcsRepo: z.string().min(1).optional(),
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
    200: { description: "Workflow details with auto-generated edges" },
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
  body: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    definition: WorkflowDefinitionSchema.optional(),
    triggers: z.array(TriggerConfigSchema).optional(),
    cooldown: CooldownConfigSchema.optional().nullable(),
    input: z.record(z.string(), InputValueSchema).optional().nullable(),
    triggerSchema: z.record(z.string(), z.unknown()).optional().nullable(),
    dir: z.string().min(1).startsWith("/").optional().nullable(),
    vcsRepo: z.string().min(1).optional().nullable(),
    enabled: z.boolean().optional(),
  }),
  responses: {
    200: { description: "Workflow updated (version snapshot created)" },
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

const triggerWorkflowRoute = route({
  method: "post",
  path: "/api/workflows/{id}/trigger",
  pattern: ["api", "workflows", null, "trigger"],
  summary: "Trigger a workflow execution",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  responses: {
    201: { description: "Workflow run started (or skipped if cooldown active)" },
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
  query: z.object({
    status: WorkflowRunStatusSchema.optional(),
  }),
  responses: {
    200: { description: "Workflow run list" },
  },
});

const getWorkflowRunRoute = route({
  method: "get",
  path: "/api/workflow-runs/{id}",
  pattern: ["api", "workflow-runs", null],
  summary: "Get a workflow run with steps (includes retry columns)",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Workflow run details with steps including retry info" },
    404: { description: "Run not found" },
  },
});

const retryWorkflowRunRoute = route({
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

const listExecutorTypesRoute = route({
  method: "get",
  path: "/api/executor-types",
  pattern: ["api", "executor-types"],
  summary: "List all executor types with their config and output schemas",
  tags: ["Workflows"],
  responses: {
    200: { description: "List of executor types with schemas" },
  },
});

const getExecutorTypeRoute = route({
  method: "get",
  path: "/api/executor-types/{type}",
  pattern: ["api", "executor-types", null],
  summary: "Get a specific executor type with its schemas",
  tags: ["Workflows"],
  params: z.object({ type: z.string() }),
  responses: {
    200: { description: "Executor type details" },
    404: { description: "Executor type not found" },
  },
});

const webhookTriggerRoute = route({
  method: "post",
  path: "/api/webhooks/{workflowId}",
  pattern: ["api", "webhooks", null],
  summary: "Trigger workflow via webhook",
  tags: ["Webhooks"],
  params: z.object({ workflowId: z.string() }),
  auth: { apiKey: false },
  responses: {
    201: { description: "Webhook processed" },
    401: { description: "Invalid signature" },
    404: { description: "Workflow not found" },
  },
});

// ─── Version History Route Definitions ────────────────────────────────────────

const listWorkflowVersionsRoute = route({
  method: "get",
  path: "/api/workflows/{id}/versions",
  pattern: ["api", "workflows", null, "versions"],
  summary: "List version history for a workflow",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Version list (newest first)" },
    404: { description: "Workflow not found" },
  },
});

const getWorkflowVersionRoute = route({
  method: "get",
  path: "/api/workflows/{id}/versions/{version}",
  pattern: ["api", "workflows", null, "versions", null],
  summary: "Get a specific version snapshot of a workflow",
  tags: ["Workflows"],
  params: z.object({ id: z.string(), version: z.coerce.number().int().min(1) }),
  responses: {
    200: { description: "Version snapshot" },
    404: { description: "Version not found" },
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
  // Executor type schemas
  if (listExecutorTypesRoute.match(req.method, pathSegments)) {
    const registry = getExecutorRegistry();
    json(res, { executorTypes: registry.describeAll() });
    return true;
  }

  if (getExecutorTypeRoute.match(req.method, pathSegments)) {
    const parsed = await getExecutorTypeRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const registry = getExecutorRegistry();
    if (!registry.has(parsed.params.type)) {
      res.writeHead(404);
      res.end();
      return true;
    }
    json(res, registry.describe(parsed.params.type));
    return true;
  }

  // Webhook trigger — needs raw body for HMAC verification, no API key auth
  if (webhookTriggerRoute.match(req.method, pathSegments)) {
    const workflowId = pathSegments[2]!;

    // Read raw body for HMAC verification
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString();

    // Validate JSON before processing (but pass raw string for HMAC)
    try {
      if (rawBody) JSON.parse(rawBody);
    } catch {
      jsonError(res, "Invalid JSON body", 400);
      return true;
    }

    const signature =
      (req.headers["x-hub-signature-256"] as string | undefined) ??
      (req.headers["x-signature"] as string | undefined);

    try {
      const result = await handleWebhookTrigger(
        workflowId,
        rawBody, // Raw body string — used for HMAC verification + passed as triggerData
        signature,
        signature,
        getExecutorRegistry(),
      );
      json(res, result, 201);
    } catch (err) {
      if (err instanceof TriggerSchemaError) {
        jsonError(res, err.message, 400);
      } else if (err instanceof WebhookError) {
        jsonError(res, err.message, err.statusCode);
      } else {
        jsonError(res, String(err), 500);
      }
    }
    return true;
  }

  // Version history routes must be checked BEFORE single workflow GET
  // (since "versions" would match the :id wildcard)
  if (getWorkflowVersionRoute.match(req.method, pathSegments)) {
    const parsed = await getWorkflowVersionRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const version = getWorkflowVersion(parsed.params.id, parsed.params.version);
    if (!version) {
      res.writeHead(404);
      res.end();
      return true;
    }
    json(res, version);
    return true;
  }

  if (listWorkflowVersionsRoute.match(req.method, pathSegments)) {
    const parsed = await listWorkflowVersionsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const workflow = getWorkflow(parsed.params.id);
    if (!workflow) {
      res.writeHead(404);
      res.end();
      return true;
    }
    const versions = getWorkflowVersions(parsed.params.id);
    json(res, { versions });
    return true;
  }

  if (listWorkflowsRoute.match(req.method, pathSegments)) {
    const workflows = listWorkflows();
    json(res, workflows);
    return true;
  }

  if (createWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await createWorkflowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    // Validate definition structure
    const validation = validateDefinition(parsed.body.definition);
    if (!validation.valid) {
      jsonError(res, `Invalid definition: ${validation.errors.join("; ")}`, 400);
      return true;
    }

    const workflow = createWorkflow({
      name: parsed.body.name,
      description: parsed.body.description,
      definition: parsed.body.definition,
      triggers: parsed.body.triggers,
      cooldown: parsed.body.cooldown,
      input: parsed.body.input,
      triggerSchema: parsed.body.triggerSchema,
      dir: parsed.body.dir,
      vcsRepo: parsed.body.vcsRepo,
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
    // Include auto-generated edges for UI rendering
    const edges = generateEdges(workflow.definition);
    json(res, { ...workflow, edges });
    return true;
  }

  if (updateWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await updateWorkflowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const { id } = parsed.params;
    const body = parsed.body;

    // Check workflow exists before snapshotting
    const existing = getWorkflow(id);
    if (!existing) {
      res.writeHead(404);
      res.end();
      return true;
    }

    // Validate new definition if provided
    if (body.definition) {
      const validation = validateDefinition(body.definition);
      if (!validation.valid) {
        jsonError(res, `Invalid definition: ${validation.errors.join("; ")}`, 400);
        return true;
      }
    }

    // Create version snapshot before applying update
    try {
      snapshotWorkflow(id, myAgentId);
    } catch {
      // Snapshot failure should not block the update — log and continue
    }

    const workflow = updateWorkflow(id, {
      name: body.name,
      description: body.description,
      definition: body.definition,
      triggers: body.triggers,
      cooldown: body.cooldown === null ? null : body.cooldown,
      input: body.input === null ? null : body.input,
      triggerSchema: body.triggerSchema === null ? null : body.triggerSchema,
      dir: body.dir === null ? null : body.dir,
      vcsRepo: body.vcsRepo === null ? null : body.vcsRepo,
      enabled: body.enabled,
    });
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

  if (triggerWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await triggerWorkflowRoute.parse(req, res, pathSegments, queryParams);
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
    const body = await parseBody<Record<string, unknown>>(req);

    let runId: string;
    try {
      runId = await startWorkflowExecution(workflow, body, getExecutorRegistry());
    } catch (err) {
      if (err instanceof TriggerSchemaError) {
        jsonError(res, err.message, 400);
        return true;
      }
      throw err;
    }

    // Check if skipped due to cooldown
    const run = getWorkflowRun(runId);
    const skipped = run?.status === "skipped";

    json(res, { runId, skipped }, 201);
    return true;
  }

  if (listWorkflowRunsRoute.match(req.method, pathSegments)) {
    const parsed = await listWorkflowRunsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    let runs = listWorkflowRuns(parsed.params.id);
    // Apply optional status filter
    if (parsed.query?.status) {
      runs = runs.filter((r) => r.status === parsed.query.status);
    }
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
    json(res, { run, steps });
    return true;
  }

  if (retryWorkflowRunRoute.match(req.method, pathSegments)) {
    const parsed = await retryWorkflowRunRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    try {
      await retryFailedRun(parsed.params.id, getExecutorRegistry());
      json(res, { success: true });
    } catch (err) {
      jsonError(res, String(err), 400);
    }
    return true;
  }

  return false;
}
