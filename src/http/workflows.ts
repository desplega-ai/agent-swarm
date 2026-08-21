import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { AssetKeyAuthorizationError, authorizeAssetKeyWrite } from "../be/asset-key-auth";
import { resolveHttpAuditUserId } from "../be/audit-user";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  getWorkflowVersion,
  getWorkflowVersions,
  listWorkflowRuns,
  listWorkflowRunsPage,
  listWorkflows,
  type updateWorkflow,
  withFavoriteFlags,
} from "../be/db";
import {
  AssetKeySchema,
  CooldownConfigSchema,
  InputValueSchema,
  TriggerConfigSchema,
  WorkflowDefinitionSchema,
  WorkflowEdgeSchema,
  WorkflowNodePatchSchema,
  WorkflowPatchSchema,
  WorkflowRunSchema,
  WorkflowRunStatusSchema,
  WorkflowRunStepSchema,
  WorkflowSchema,
  WorkflowVersionSchema,
} from "../types";
import { getExecutorRegistry, startWorkflowExecution } from "../workflows";
import { definitionNodeIds, generateEdges, validateDefinition } from "../workflows/definition";
import { TriggerSchemaError } from "../workflows/engine";
import { validateJsonSchema } from "../workflows/json-schema-validator";
import { patchWorkflowDefinition } from "../workflows/patch-definition";
import { cancelWorkflowRun, retryFailedRun } from "../workflows/resume";
import { handleWebhookTrigger, WebhookError } from "../workflows/triggers";
import { snapshotAndUpdateWorkflow } from "../workflows/version";
import { resolveHttpFavoriteOwner } from "./favorite-owner";
import { route } from "./route-def";
import { jsonError, parseBody, triggerSchemaErrorResponse } from "./utils";

// ─── Response Schemas ────────────────────────────────────────────────────────

/** `Workflow` decorated with the caller-scoped favorite flag (always set once `withFavoriteFlags` runs). */
const WorkflowWithFavoriteSchema = WorkflowSchema.extend({ favorite: z.boolean() });

/** `/api/workflows` slim list item — mirrors `WorkflowSummary` in src/types.ts (no exported schema there). */
const WorkflowSummarySchema = WorkflowSchema.omit({
  definition: true,
  triggers: true,
  cooldown: true,
  input: true,
  triggerSchema: true,
})
  .extend({ nodeCount: z.number().int() })
  .extend({ favorite: z.boolean() });

/** Mirrors `ExecutorTypeInfo` in src/workflows/executors/registry.ts. */
const ExecutorTypeInfoSchema = z.object({
  type: z.string(),
  mode: z.enum(["instant", "async"]),
  configSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
});

/** Mirrors `WorkflowRunPage` in src/be/db.ts. */
const WorkflowRunPageSchema = z.object({
  runs: z.array(WorkflowRunSchema),
  page: z.object({
    limit: z.number().int(),
    offset: z.number().int(),
    total: z.number().int(),
    hasMore: z.boolean(),
    nextOffset: z.number().int().optional(),
  }),
});

const SuccessResponseSchema = z.object({ success: z.literal(true) });

// ─── Route Definitions ───────────────────────────────────────────────────────

const listWorkflowsRoute = route({
  method: "get",
  path: "/api/workflows",
  pattern: ["api", "workflows"],
  summary: "List all workflows",
  description:
    "Returns workflows WITHOUT the heavy `definition` (the full DAG) by default — the list view only needs a `nodeCount`, which is included. Pass `fields=full` to restore `definition` + trigger config. Fetch the full workflow via `GET /api/workflows/{id}`.",
  tags: ["Workflows"],
  query: z.object({
    enabled: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
    consecutiveErrorsMin: z.coerce.number().int().min(0).optional(),
    lastRunStatus: WorkflowRunStatusSchema.optional(),
    key: AssetKeySchema.optional(),
    keyPrefix: AssetKeySchema.optional(),
    /** `full` restores the legacy shape (includes `definition`); default is slim. */
    fields: z.enum(["full", "slim"]).optional(),
  }),
  responses: {
    200: {
      description: "Workflow list",
      schema: z.union([z.array(WorkflowSummarySchema), z.array(WorkflowWithFavoriteSchema)]),
    },
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
    key: AssetKeySchema.optional(),
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
    201: { description: "Workflow created", schema: WorkflowSchema },
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
    200: {
      description: "Workflow details with auto-generated edges",
      // `favorite` stays optional here (unlike the list routes) because the
      // handler falls back to the undecorated `workflow` (no `favorite`) if
      // `withFavoriteFlags` ever returns an empty array for a truthy input.
      schema: WorkflowSchema.extend({
        favorite: z.boolean().optional(),
        edges: z.array(WorkflowEdgeSchema),
      }),
    },
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
    key: AssetKeySchema.optional(),
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
    200: { description: "Workflow updated (version snapshot created)", schema: WorkflowSchema },
    400: { description: "Invalid definition" },
    404: { description: "Workflow not found" },
  },
});

const patchWorkflowRoute = route({
  method: "patch",
  path: "/api/workflows/{id}",
  pattern: ["api", "workflows", null],
  summary: "Patch a workflow definition (create/update/delete nodes)",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  body: WorkflowPatchSchema.extend({ key: AssetKeySchema.optional() }),
  responses: {
    200: { description: "Workflow patched (version snapshot created)", schema: WorkflowSchema },
    400: { description: "Invalid patch or resulting definition" },
    404: { description: "Workflow not found" },
  },
});

const patchWorkflowNodeRoute = route({
  method: "patch",
  path: "/api/workflows/{id}/nodes/{nodeId}",
  pattern: ["api", "workflows", null, "nodes", null],
  summary: "Patch a single node in a workflow definition",
  tags: ["Workflows"],
  params: z.object({ id: z.string(), nodeId: z.string() }),
  body: WorkflowNodePatchSchema,
  responses: {
    200: { description: "Node patched (version snapshot created)", schema: WorkflowSchema },
    400: { description: "Invalid patch or resulting definition" },
    404: { description: "Workflow or node not found" },
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
    201: {
      description: "Workflow run started (or skipped if cooldown active)",
      schema: z.object({ runId: z.string(), skipped: z.boolean() }),
    },
    400: { description: "Workflow is disabled" },
    401: { description: "Unauthorized" },
    404: { description: "Workflow not found" },
  },
});

const validateTriggerRoute = route({
  method: "post",
  path: "/api/workflows/{id}/trigger/validate",
  pattern: ["api", "workflows", null, "trigger", "validate"],
  summary: "Validate a payload against the workflow's triggerSchema (no run)",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  responses: {
    200: {
      description: "Payload matches the workflow's triggerSchema (or workflow has none)",
      schema: z.object({ valid: z.literal(true), schema: z.null().optional() }),
    },
    400: { description: "Payload failed validation; body matches the TriggerSchemaError contract" },
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
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
  responses: {
    200: {
      description: "Workflow run list",
      schema: z.union([z.array(WorkflowRunSchema), WorkflowRunPageSchema]),
    },
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
    200: {
      description: "Workflow run details with steps including retry info",
      schema: z.object({ run: WorkflowRunSchema, steps: z.array(WorkflowRunStepSchema) }),
    },
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
    200: { description: "Retry started", schema: SuccessResponseSchema },
    400: { description: "Cannot retry" },
  },
});

const cancelWorkflowRunRoute = route({
  method: "post",
  path: "/api/workflow-runs/{id}/cancel",
  pattern: ["api", "workflow-runs", null, "cancel"],
  summary: "Cancel a running or waiting workflow run",
  tags: ["Workflows"],
  params: z.object({ id: z.string() }),
  body: z.object({ reason: z.string().optional() }).optional(),
  responses: {
    200: { description: "Run cancelled", schema: SuccessResponseSchema },
    400: { description: "Cannot cancel" },
  },
  auth: { apiKey: true },
});

const listExecutorTypesRoute = route({
  method: "get",
  path: "/api/executor-types",
  pattern: ["api", "executor-types"],
  summary: "List all executor types with their config and output schemas",
  tags: ["Workflows"],
  responses: {
    200: {
      description: "List of executor types with schemas",
      schema: z.object({ executorTypes: z.array(ExecutorTypeInfoSchema) }),
    },
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
    200: { description: "Executor type details", schema: ExecutorTypeInfoSchema },
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
    201: { description: "Webhook processed", schema: z.object({ runId: z.string() }) },
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
    200: {
      description: "Version list (newest first)",
      schema: z.object({ versions: z.array(WorkflowVersionSchema) }),
    },
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
    200: { description: "Version snapshot", schema: WorkflowVersionSchema },
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
    listExecutorTypesRoute.respond(res, 200, { executorTypes: registry.describeAll() });
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
    getExecutorTypeRoute.respond(res, 200, registry.describe(parsed.params.type));
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

    let result: Awaited<ReturnType<typeof handleWebhookTrigger>>;
    try {
      result = await handleWebhookTrigger(
        workflowId,
        rawBody, // Raw body string — HMAC is verified against raw bytes; JSON parsing happens inside
        req.headers, // Full header bag — signature header resolved per trigger config
        getExecutorRegistry(),
      );
    } catch (err) {
      if (err instanceof TriggerSchemaError) {
        triggerSchemaErrorResponse(res, err.message, err.validationErrors);
      } else if (err instanceof WebhookError) {
        jsonError(res, err.message, err.statusCode);
      } else {
        jsonError(res, String(err), 500);
      }
      return true;
    }
    // Egress stays OUTSIDE the try: `respond()` runtime-validates in dev/test
    // and must fail loudly rather than be reported as a webhook failure for a
    // run that already started.
    webhookTriggerRoute.respond(res, 201, result);
    return true;
  }

  // Version history routes must be checked BEFORE single workflow GET
  // (since "versions" would match the :id wildcard)
  if (getWorkflowVersionRoute.match(req.method, pathSegments)) {
    const parsed = await getWorkflowVersionRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const version = await getWorkflowVersion(parsed.params.id, parsed.params.version);
    if (!version) {
      res.writeHead(404);
      res.end();
      return true;
    }
    getWorkflowVersionRoute.respond(res, 200, version);
    return true;
  }

  if (listWorkflowVersionsRoute.match(req.method, pathSegments)) {
    const parsed = await listWorkflowVersionsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const workflow = await getWorkflow(parsed.params.id);
    if (!workflow) {
      res.writeHead(404);
      res.end();
      return true;
    }
    const versions = await getWorkflowVersions(parsed.params.id);
    listWorkflowVersionsRoute.respond(res, 200, { versions });
    return true;
  }

  if (listWorkflowsRoute.match(req.method, pathSegments)) {
    const parsed = await listWorkflowsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const favoriteScope = (await resolveHttpFavoriteOwner(req, myAgentId))?.scope;
    const filters = {
      enabled: parsed.query.enabled,
      consecutiveErrorsMin: parsed.query.consecutiveErrorsMin,
      lastRunStatus: parsed.query.lastRunStatus,
      key: parsed.query.key,
      keyPrefix: parsed.query.keyPrefix,
    };
    // List responses default to slim (no `definition`); `?fields=full` restores it.
    if (parsed.query.fields === "full") {
      listWorkflowsRoute.respond(
        res,
        200,
        await withFavoriteFlags(await listWorkflows(filters), {
          favoriteScope,
          itemType: "workflow",
        }),
      );
    } else {
      listWorkflowsRoute.respond(
        res,
        200,
        await withFavoriteFlags(await listWorkflows(filters, { slim: true }), {
          favoriteScope,
          itemType: "workflow",
        }),
      );
    }
    return true;
  }

  if (createWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await createWorkflowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    // Validate definition structure
    const validation = validateDefinition(parsed.body.definition, getExecutorRegistry());
    if (!validation.valid) {
      jsonError(res, `Invalid definition: ${validation.errors.join("; ")}`, 400);
      return true;
    }

    const trustedUserId = await resolveHttpAuditUserId(req, myAgentId);
    let key: string | undefined;
    try {
      key = parsed.body.key
        ? await authorizeAssetKeyWrite(parsed.body.key, trustedUserId)
        : undefined;
    } catch (error) {
      if (error instanceof AssetKeyAuthorizationError) {
        jsonError(res, error.message, error.statusCode);
        return true;
      }
      throw error;
    }

    const workflow = await createWorkflow(
      {
        key,
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
        createdBy: (await resolveHttpAuditUserId(req, myAgentId)) ?? undefined,
      },
      "api",
    );
    createWorkflowRoute.respond(res, 201, workflow);
    return true;
  }

  if (getWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await getWorkflowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const workflow = await getWorkflow(parsed.params.id);
    if (!workflow) {
      res.writeHead(404);
      res.end();
      return true;
    }
    // Include auto-generated edges for UI rendering
    const edges = generateEdges(workflow.definition);
    const favoriteScope = (await resolveHttpFavoriteOwner(req, myAgentId))?.scope;
    const [decorated] = await withFavoriteFlags([workflow], {
      favoriteScope,
      itemType: "workflow",
    });
    getWorkflowRoute.respond(res, 200, { ...(decorated ?? workflow), edges });
    return true;
  }

  // PATCH single node (5-segment) must be checked before bulk PATCH (3-segment)
  if (patchWorkflowNodeRoute.match(req.method, pathSegments)) {
    const parsed = await patchWorkflowNodeRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const { id, nodeId } = parsed.params;

    const updatedBy0 = (await resolveHttpAuditUserId(req, myAgentId)) ?? undefined;
    // Convert single-node patch to bulk patch format
    const result = await patchWorkflowDefinition({
      id,
      patch: { update: [{ nodeId, node: parsed.body }] },
      registry: getExecutorRegistry(),
      snapshotAgentId: myAgentId,
      snapshotOptional: true,
      updates: { updatedBy: updatedBy0 },
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        res.writeHead(404);
        res.end();
        return true;
      }
      jsonError(
        res,
        result.reason === "patch"
          ? result.errors.join("; ")
          : `Invalid definition: ${result.errors.join("; ")}`,
        400,
      );
      return true;
    }
    patchWorkflowNodeRoute.respond(res, 200, result.workflow);
    return true;
  }

  if (patchWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await patchWorkflowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const { id } = parsed.params;

    const updatedBy1 = await resolveHttpAuditUserId(req, myAgentId);
    const updateArgs: Omit<Parameters<typeof updateWorkflow>[1], "definition"> = {};
    if (parsed.body.key !== undefined) {
      try {
        updateArgs.key = await authorizeAssetKeyWrite(parsed.body.key, updatedBy1);
      } catch (error) {
        if (error instanceof AssetKeyAuthorizationError) {
          jsonError(res, error.message, error.statusCode);
          return true;
        }
        throw error;
      }
    }
    if (parsed.body.triggerSchema !== undefined) {
      updateArgs.triggerSchema = parsed.body.triggerSchema;
    }
    if (updatedBy1 !== null) {
      updateArgs.updatedBy = updatedBy1;
    }

    const result = await patchWorkflowDefinition({
      id,
      patch: parsed.body,
      registry: getExecutorRegistry(),
      snapshotAgentId: myAgentId,
      snapshotOptional: true,
      updates: updateArgs,
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        res.writeHead(404);
        res.end();
        return true;
      }
      jsonError(
        res,
        result.reason === "patch"
          ? result.errors.join("; ")
          : `Invalid definition: ${result.errors.join("; ")}`,
        400,
      );
      return true;
    }
    patchWorkflowRoute.respond(res, 200, result.workflow);
    return true;
  }

  if (updateWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await updateWorkflowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const { id } = parsed.params;
    const body = parsed.body;

    // Check workflow exists before snapshotting
    const existing = await getWorkflow(id);
    if (!existing) {
      res.writeHead(404);
      res.end();
      return true;
    }

    // Validate new definition if provided
    if (body.definition) {
      const validation = validateDefinition(body.definition, getExecutorRegistry(), {
        legacyNodeIds: definitionNodeIds(existing.definition),
      });
      if (!validation.valid) {
        jsonError(res, `Invalid definition: ${validation.errors.join("; ")}`, 400);
        return true;
      }
    }

    const updatedBy2 = (await resolveHttpAuditUserId(req, myAgentId)) ?? undefined;
    let key: string | undefined;
    if (body.key !== undefined) {
      try {
        key = await authorizeAssetKeyWrite(body.key, updatedBy2);
      } catch (error) {
        if (error instanceof AssetKeyAuthorizationError) {
          jsonError(res, error.message, error.statusCode);
          return true;
        }
        throw error;
      }
    }
    // Snapshot + update in one transaction: concurrent full updates would
    // otherwise allocate the same version, and the loser's edit would commit
    // with no history row. Snapshot failure still does not block the update.
    const { workflow } = await snapshotAndUpdateWorkflow(
      id,
      {
        key,
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
        updatedBy: updatedBy2,
      },
      { changedByAgentId: myAgentId, snapshotOptional: true },
    );
    if (!workflow) {
      res.writeHead(404);
      res.end();
      return true;
    }
    updateWorkflowRoute.respond(res, 200, workflow);
    return true;
  }

  if (deleteWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await deleteWorkflowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    try {
      const deleted = await deleteWorkflow(parsed.params.id, "api");
      res.writeHead(deleted ? 204 : 404);
    } catch (err) {
      jsonError(res, String(err), 500);
      return true;
    }
    res.end();
    return true;
  }

  if (validateTriggerRoute.match(req.method, pathSegments)) {
    const parsed = await validateTriggerRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const workflow = await getWorkflow(parsed.params.id);
    if (!workflow) {
      res.writeHead(404);
      res.end();
      return true;
    }
    const body = await parseBody<Record<string, unknown>>(req);
    const triggerData = (body?.triggerData ?? body) as unknown;
    if (!workflow.triggerSchema) {
      validateTriggerRoute.respond(res, 200, { valid: true, schema: null });
      return true;
    }
    const errors = validateJsonSchema(workflow.triggerSchema, triggerData);
    if (errors.length > 0) {
      triggerSchemaErrorResponse(
        res,
        `Trigger schema validation failed: ${errors.join("; ")}`,
        errors,
      );
      return true;
    }
    validateTriggerRoute.respond(res, 200, { valid: true });
    return true;
  }

  if (triggerWorkflowRoute.match(req.method, pathSegments)) {
    const parsed = await triggerWorkflowRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const workflow = await getWorkflow(parsed.params.id);
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
      runId = await startWorkflowExecution(workflow, body, getExecutorRegistry(), {
        triggerType: "api",
        requestedByUserId: (await resolveHttpAuditUserId(req, myAgentId)) ?? undefined,
      });
    } catch (err) {
      if (err instanceof TriggerSchemaError) {
        triggerSchemaErrorResponse(res, err.message, err.validationErrors);
        return true;
      }
      throw err;
    }

    // Check if skipped due to cooldown
    const run = await getWorkflowRun(runId);
    const skipped = run?.status === "skipped";

    triggerWorkflowRoute.respond(res, 201, { runId, skipped });
    return true;
  }

  if (listWorkflowRunsRoute.match(req.method, pathSegments)) {
    const parsed = await listWorkflowRunsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const paginationRequested =
      parsed.query?.limit !== undefined || parsed.query?.offset !== undefined;
    if (paginationRequested) {
      const page = await listWorkflowRunsPage(parsed.params.id, {
        status: parsed.query?.status,
        limit: parsed.query?.limit ?? 20,
        offset: parsed.query?.offset ?? 0,
      });
      listWorkflowRunsRoute.respond(res, 200, page);
      return true;
    }
    // Preserve the pre-pagination response for the UI when limit/offset are
    // omitted: a bare array containing every matching run.
    const runs = await listWorkflowRuns(parsed.params.id, { status: parsed.query?.status });
    listWorkflowRunsRoute.respond(res, 200, runs);
    return true;
  }

  if (getWorkflowRunRoute.match(req.method, pathSegments)) {
    const parsed = await getWorkflowRunRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const run = await getWorkflowRun(parsed.params.id);
    if (!run) {
      res.writeHead(404);
      res.end();
      return true;
    }
    const steps = await getWorkflowRunStepsByRunId(parsed.params.id);
    getWorkflowRunRoute.respond(res, 200, { run, steps });
    return true;
  }

  if (retryWorkflowRunRoute.match(req.method, pathSegments)) {
    const parsed = await retryWorkflowRunRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    try {
      await retryFailedRun(parsed.params.id, getExecutorRegistry());
    } catch (err) {
      jsonError(res, String(err), 400);
      return true;
    }
    // Outside the try — a response-schema violation must not be reported as a
    // 400 "cannot retry" after the retry already started.
    retryWorkflowRunRoute.respond(res, 200, { success: true });
    return true;
  }

  if (cancelWorkflowRunRoute.match(req.method, pathSegments)) {
    const parsed = await cancelWorkflowRunRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    try {
      await cancelWorkflowRun(parsed.params.id, parsed.body?.reason);
    } catch (err) {
      jsonError(res, String(err), 400);
      return true;
    }
    // Outside the try — a response-schema violation must not be reported as a
    // 400 "cannot cancel" after the run was already cancelled.
    cancelWorkflowRunRoute.respond(res, 200, { success: true });
    return true;
  }

  return false;
}
