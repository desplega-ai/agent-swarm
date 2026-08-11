import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDb } from "../be/db";
import {
  AgentRunsResponseSchema,
  AuditResponseSchema,
  CreateImplementationIntentBodySchema,
  CreateWorkItemBodySchema,
  CurrentOrganizationResponseSchema,
  DevFlowErrorResponseSchema,
  FactoryExecutionResponseSchema,
  ImplementationIntentsResponseSchema,
  RepositoryTargetBodySchema,
  RepositoryTargetsResponseSchema,
  ScopeBodySchema,
  ScopeResponseSchema,
  SpecBodySchema,
  SpecResponseSchema,
  StartAgentRunBodySchema,
  TransitionBodySchema,
  UpdateWorkItemBodySchema,
  WorkItemDetailResponseSchema,
  WorkItemListResponseSchema,
} from "../devflow/api/schemas";
import { DevFlowError } from "../devflow/domain/errors";
import {
  type DevFlowContext,
  DevFlowStateSchema,
  DevFlowWorkItemTypeSchema,
} from "../devflow/domain/types";
import { createDevFlowRepository, type DevFlowRepository } from "../devflow/repository";
import { createAgentAdapter } from "../devflow/services/agent-adapter";
import { createEvidenceService } from "../devflow/services/evidence-service";
import { createFactoryAdapter } from "../devflow/services/factory-adapter";
import { createImplementationIntentService } from "../devflow/services/implementation-intent-service";
import { createTransitionService } from "../devflow/services/transition-service";
import { can, type PermissionVerb } from "../rbac";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";

const errorResponses = {
  403: { description: "Forbidden", schema: DevFlowErrorResponseSchema },
  404: { description: "Not found", schema: DevFlowErrorResponseSchema },
  409: { description: "Conflict", schema: DevFlowErrorResponseSchema },
  422: {
    description: "Preconditions not met",
    schema: DevFlowErrorResponseSchema,
  },
} as const;

const currentOrganizationRoute = route({
  method: "get",
  path: "/api/devflow/v1/organizations/current",
  pattern: ["api", "devflow", "v1", "organizations", "current"],
  summary: "Get the current DevFlow organization and membership",
  tags: ["DevFlow"],
  responses: {
    200: {
      description: "Current organization",
      schema: CurrentOrganizationResponseSchema,
    },
    ...errorResponses,
  },
  auth: { apiKey: true },
});

const listWorkItemsRoute = route({
  method: "get",
  path: "/api/devflow/v1/work-items",
  pattern: ["api", "devflow", "v1", "work-items"],
  summary: "List tenant-scoped DevFlow work items",
  tags: ["DevFlow"],
  query: z.object({
    state: DevFlowStateSchema.optional(),
    type: DevFlowWorkItemTypeSchema.optional(),
    search: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
  responses: {
    200: { description: "Work item page", schema: WorkItemListResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
});

const createWorkItemRoute = route({
  method: "post",
  path: "/api/devflow/v1/work-items",
  pattern: ["api", "devflow", "v1", "work-items"],
  summary: "Capture a DevFlow work item",
  tags: ["DevFlow"],
  body: CreateWorkItemBodySchema,
  responses: {
    201: {
      description: "Captured work item",
      schema: WorkItemDetailResponseSchema,
    },
    ...errorResponses,
  },
  auth: { apiKey: true },
  rbac: { permission: "devflow.work-item.write" },
});

const getWorkItemRoute = route({
  method: "get",
  path: "/api/devflow/v1/work-items/{id}",
  pattern: ["api", "devflow", "v1", "work-items", null],
  summary: "Get a DevFlow work item and its evidence",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: {
      description: "Work item detail",
      schema: WorkItemDetailResponseSchema,
    },
    ...errorResponses,
  },
  auth: { apiKey: true },
});

const updateWorkItemRoute = route({
  method: "patch",
  path: "/api/devflow/v1/work-items/{id}",
  pattern: ["api", "devflow", "v1", "work-items", null],
  summary: "Update editable DevFlow work item fields",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  body: UpdateWorkItemBodySchema,
  responses: {
    200: {
      description: "Updated work item",
      schema: WorkItemDetailResponseSchema,
    },
    ...errorResponses,
  },
  auth: { apiKey: true },
  rbac: { permission: "devflow.work-item.write" },
});

const transitionWorkItemRoute = route({
  method: "post",
  path: "/api/devflow/v1/work-items/{id}/transitions",
  pattern: ["api", "devflow", "v1", "work-items", null, "transitions"],
  summary: "Request a deterministic DevFlow lifecycle transition",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  body: TransitionBodySchema,
  responses: {
    200: {
      description: "Transitioned work item",
      schema: WorkItemDetailResponseSchema,
    },
    ...errorResponses,
  },
  auth: { apiKey: true },
  rbac: { permission: "devflow.gate.approve" },
});

const getScopeRoute = route({
  method: "get",
  path: "/api/devflow/v1/work-items/{id}/scope",
  pattern: ["api", "devflow", "v1", "work-items", null, "scope"],
  summary: "Get the current DevFlow scope",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: { description: "Current scope", schema: ScopeResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
});

const putScopeRoute = route({
  method: "put",
  path: "/api/devflow/v1/work-items/{id}/scope",
  pattern: ["api", "devflow", "v1", "work-items", null, "scope"],
  summary: "Create or revise a DevFlow scope draft",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  body: ScopeBodySchema,
  responses: {
    200: { description: "Saved scope", schema: ScopeResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
  rbac: { permission: "devflow.work-item.write" },
});

const getSpecRoute = route({
  method: "get",
  path: "/api/devflow/v1/work-items/{id}/spec",
  pattern: ["api", "devflow", "v1", "work-items", null, "spec"],
  summary: "Get the current DevFlow spec version",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: { description: "Current spec", schema: SpecResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
});

const putSpecRoute = route({
  method: "put",
  path: "/api/devflow/v1/work-items/{id}/spec",
  pattern: ["api", "devflow", "v1", "work-items", null, "spec"],
  summary: "Create a new immutable DevFlow spec version",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  body: SpecBodySchema,
  responses: {
    200: { description: "Saved spec", schema: SpecResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
  rbac: { permission: "devflow.work-item.write" },
});

const listAgentRunsRoute = route({
  method: "get",
  path: "/api/devflow/v1/work-items/{id}/agent-runs",
  pattern: ["api", "devflow", "v1", "work-items", null, "agent-runs"],
  summary: "List Agent Swarm runs for a DevFlow item",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: { description: "Agent runs", schema: AgentRunsResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
});

const startAgentRunRoute = route({
  method: "post",
  path: "/api/devflow/v1/work-items/{id}/agent-runs",
  pattern: ["api", "devflow", "v1", "work-items", null, "agent-runs"],
  summary: "Start bounded DevFlow work on Agent Swarm",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  body: StartAgentRunBodySchema,
  responses: {
    202: { description: "Queued agent run", schema: AgentRunsResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
  rbac: { permission: "devflow.agent-run.start" },
});

const reconcileAgentRunRoute = route({
  method: "post",
  path: "/api/devflow/v1/agent-runs/{id}/reconcile",
  pattern: ["api", "devflow", "v1", "agent-runs", null, "reconcile"],
  summary: "Reconcile a DevFlow run with its Agent Swarm task",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  body: z.object({}),
  responses: {
    200: {
      description: "Reconciled agent run",
      schema: AgentRunsResponseSchema,
    },
    ...errorResponses,
  },
  auth: { apiKey: true },
  rbac: { permission: "devflow.agent-run.start" },
});

const getAuditRoute = route({
  method: "get",
  path: "/api/devflow/v1/work-items/{id}/audit",
  pattern: ["api", "devflow", "v1", "work-items", null, "audit"],
  summary: "Get immutable DevFlow audit evidence",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: { description: "Audit events", schema: AuditResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
});

const listRepositoryTargetsRoute = route({
  method: "get",
  path: "/api/devflow/v1/repository-targets",
  pattern: ["api", "devflow", "v1", "repository-targets"],
  summary: "List configured DevFlow implementation repositories",
  tags: ["DevFlow"],
  responses: {
    200: { description: "Repository targets", schema: RepositoryTargetsResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
});

const createRepositoryTargetRoute = route({
  method: "post",
  path: "/api/devflow/v1/repository-targets",
  pattern: ["api", "devflow", "v1", "repository-targets"],
  summary: "Configure a DevFlow Command Center Factory target",
  tags: ["DevFlow"],
  body: RepositoryTargetBodySchema,
  responses: {
    201: { description: "Repository target", schema: RepositoryTargetsResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
  rbac: { permission: "devflow.factory.execute" },
});

const listImplementationIntentsRoute = route({
  method: "get",
  path: "/api/devflow/v1/work-items/{id}/implementation-intents",
  pattern: ["api", "devflow", "v1", "work-items", null, "implementation-intents"],
  summary: "List immutable implementation intents and their Factory executions",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: { description: "Implementation intents", schema: ImplementationIntentsResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
});

const createImplementationIntentRoute = route({
  method: "post",
  path: "/api/devflow/v1/work-items/{id}/implementation-intents",
  pattern: ["api", "devflow", "v1", "work-items", null, "implementation-intents"],
  summary: "Create an immutable intent and dispatch it to Command Center Factory",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  body: CreateImplementationIntentBodySchema,
  responses: {
    202: { description: "Queued Factory execution", schema: ImplementationIntentsResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
  rbac: { permission: "devflow.factory.execute" },
});

const getFactoryExecutionRoute = route({
  method: "get",
  path: "/api/devflow/v1/factory-executions/{id}",
  pattern: ["api", "devflow", "v1", "factory-executions", null],
  summary: "Get independently verified Factory execution evidence",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: { description: "Factory execution", schema: FactoryExecutionResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
});

const reconcileFactoryExecutionRoute = route({
  method: "post",
  path: "/api/devflow/v1/factory-executions/{id}/reconcile",
  pattern: ["api", "devflow", "v1", "factory-executions", null, "reconcile"],
  summary: "Reconcile a Factory execution from canonical Git evidence",
  tags: ["DevFlow"],
  params: z.object({ id: z.string().uuid() }),
  body: z.object({}),
  responses: {
    200: { description: "Factory execution", schema: FactoryExecutionResponseSchema },
    ...errorResponses,
  },
  auth: { apiKey: true },
  rbac: { permission: "devflow.factory.execute" },
});

type RequestContext = { repo: DevFlowRepository; context: DevFlowContext };

function oneHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function resolveContext(req: IncomingMessage): RequestContext {
  const repo = createDevFlowRepository(getDb());
  const auth = getRequestAuth(req);
  const userId = auth?.kind === "user" ? auth.userId : oneHeader(req, "x-devflow-user-id");
  if (!userId) {
    throw new DevFlowError(403, "user_identity_required", "DevFlow requires a user identity.");
  }
  const preferredOrganizationId = oneHeader(req, "x-devflow-organization-id");
  let membership = preferredOrganizationId
    ? repo.getMembership(preferredOrganizationId, userId)
    : repo.findMembershipForUser(userId);

  if (!membership && !preferredOrganizationId) {
    const organization =
      repo.getOrganizationBySlug("tenant-zero") ??
      repo.createOrganization({ name: "Tenant Zero", slug: "tenant-zero" });
    membership = repo.addMembership({
      organizationId: organization.id,
      userId,
      role: "admin",
    });
  }
  if (!membership) {
    throw new DevFlowError(
      403,
      "organization_membership_required",
      "The user is not an active member of the requested DevFlow organization.",
    );
  }
  return {
    repo,
    context: {
      organizationId: membership.organizationId,
      actorKind: "user",
      actorId: userId,
      correlationId: oneHeader(req, "x-correlation-id"),
    },
  };
}

function ensurePermission(
  _req: IncomingMessage,
  res: ServerResponse,
  verb: Extract<
    PermissionVerb,
    | "devflow.work-item.write"
    | "devflow.gate.approve"
    | "devflow.agent-run.start"
    | "devflow.factory.execute"
  >,
  userId: string,
): boolean {
  const decision = can({
    principal: { kind: "user", userId },
    verb,
    resource: { kind: "none" },
    source: "http",
  });
  if (decision.allow) return true;
  sendDevFlowError(
    res,
    new DevFlowError(403, "insufficient_permission", decision.reason, {
      missing: decision.missing,
    }),
  );
  return false;
}

function sendDevFlowError(res: ServerResponse, error: unknown): void {
  const devflowError =
    error instanceof DevFlowError
      ? error
      : new DevFlowError(
          422,
          "request_failed",
          error instanceof Error ? error.message : "DevFlow request failed.",
        );
  res.writeHead(devflowError.status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: devflowError.message,
      error_code: devflowError.errorCode,
      ...(Object.keys(devflowError.details).length ? { details: devflowError.details } : {}),
    }),
  );
}

function detail(repo: DevFlowRepository, organizationId: string, id: string) {
  const item = repo.getWorkItem(organizationId, id);
  if (!item) throw new DevFlowError(404, "not_found", "DevFlow work item not found.");
  return {
    item,
    scope: repo.getScope(organizationId, id),
    spec: repo.getCurrentSpec(organizationId, id),
    agentRuns: repo.listAgentRuns(organizationId, id),
    audit: repo.listAuditEvents(organizationId, id),
  };
}

function publicRepositoryTarget(target: ReturnType<DevFlowRepository["createRepositoryTarget"]>) {
  const { checkoutPath: _checkoutPath, ...publicTarget } = target;
  return publicTarget;
}

export async function handleDevFlow(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  const routes = [
    currentOrganizationRoute,
    listWorkItemsRoute,
    createWorkItemRoute,
    getWorkItemRoute,
    updateWorkItemRoute,
    transitionWorkItemRoute,
    getScopeRoute,
    putScopeRoute,
    getSpecRoute,
    putSpecRoute,
    listAgentRunsRoute,
    startAgentRunRoute,
    reconcileAgentRunRoute,
    getAuditRoute,
    listRepositoryTargetsRoute,
    createRepositoryTargetRoute,
    listImplementationIntentsRoute,
    createImplementationIntentRoute,
    getFactoryExecutionRoute,
    reconcileFactoryExecutionRoute,
  ];
  if (!routes.some((candidate) => candidate.match(req.method, pathSegments))) return false;

  try {
    const { repo, context } = resolveContext(req);
    const actorId = context.actorId!;
    const transitions = createTransitionService(repo);
    const adapter = createAgentAdapter({
      repo,
      evidence: createEvidenceService(repo, transitions),
    });
    const factoryAdapter = createFactoryAdapter({ repo });
    const intentService = createImplementationIntentService(repo);

    if (currentOrganizationRoute.match(req.method, pathSegments)) {
      const organization = repo.getOrganization(context.organizationId)!;
      const membership = repo.getMembership(context.organizationId, actorId)!;
      currentOrganizationRoute.respond(res, 200, { organization, membership });
      return true;
    }
    if (listWorkItemsRoute.match(req.method, pathSegments)) {
      const parsed = await listWorkItemsRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      listWorkItemsRoute.respond(
        res,
        200,
        repo.listWorkItems(context.organizationId, parsed.query),
      );
      return true;
    }
    if (createWorkItemRoute.match(req.method, pathSegments)) {
      const parsed = await createWorkItemRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(req, res, "devflow.work-item.write", actorId)) return true;
      const item = repo.transaction(() => {
        const created = repo.createWorkItem({
          organizationId: context.organizationId,
          pmOwnerId: actorId,
          ...parsed.body,
        });
        repo.appendAuditEvent({
          context,
          workItemId: created.id,
          action: "work_item.captured",
          afterState: "captured",
          metadata: { createdVia: created.createdVia },
        });
        return created;
      });
      createWorkItemRoute.respond(res, 201, detail(repo, context.organizationId, item.id));
      return true;
    }
    if (getWorkItemRoute.match(req.method, pathSegments)) {
      const parsed = await getWorkItemRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      getWorkItemRoute.respond(res, 200, detail(repo, context.organizationId, parsed.params.id));
      return true;
    }
    if (updateWorkItemRoute.match(req.method, pathSegments)) {
      const parsed = await updateWorkItemRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(req, res, "devflow.work-item.write", actorId)) return true;
      repo.transaction(() => {
        repo.updateWorkItem(context.organizationId, parsed.params.id, parsed.body);
        repo.appendAuditEvent({
          context,
          workItemId: parsed.params.id,
          action: "work_item.updated",
          metadata: { fields: Object.keys(parsed.body) },
        });
      });
      updateWorkItemRoute.respond(res, 200, detail(repo, context.organizationId, parsed.params.id));
      return true;
    }
    if (transitionWorkItemRoute.match(req.method, pathSegments)) {
      const parsed = await transitionWorkItemRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(req, res, "devflow.gate.approve", actorId)) return true;
      transitions.transition(context, parsed.params.id, parsed.body);
      transitionWorkItemRoute.respond(
        res,
        200,
        detail(repo, context.organizationId, parsed.params.id),
      );
      return true;
    }
    if (getScopeRoute.match(req.method, pathSegments)) {
      const parsed = await getScopeRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      if (!repo.getWorkItem(context.organizationId, parsed.params.id)) {
        throw new DevFlowError(404, "not_found", "DevFlow work item not found.");
      }
      getScopeRoute.respond(res, 200, {
        scope: repo.getScope(context.organizationId, parsed.params.id),
      });
      return true;
    }
    if (putScopeRoute.match(req.method, pathSegments)) {
      const parsed = await putScopeRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(req, res, "devflow.work-item.write", actorId)) return true;
      const scope = repo.transaction(() => {
        const saved = repo.upsertScope(context.organizationId, parsed.params.id, parsed.body);
        repo.appendAuditEvent({
          context,
          workItemId: parsed.params.id,
          action: "scope.updated",
          metadata: { scopeId: saved.id },
        });
        return saved;
      });
      putScopeRoute.respond(res, 200, { scope });
      return true;
    }
    if (getSpecRoute.match(req.method, pathSegments)) {
      const parsed = await getSpecRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      if (!repo.getWorkItem(context.organizationId, parsed.params.id)) {
        throw new DevFlowError(404, "not_found", "DevFlow work item not found.");
      }
      getSpecRoute.respond(res, 200, {
        spec: repo.getCurrentSpec(context.organizationId, parsed.params.id),
      });
      return true;
    }
    if (putSpecRoute.match(req.method, pathSegments)) {
      const parsed = await putSpecRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(req, res, "devflow.work-item.write", actorId)) return true;
      const spec = repo.transaction(() => {
        const saved = repo.createSpecVersion(context.organizationId, parsed.params.id, parsed.body);
        repo.updateWorkItem(context.organizationId, parsed.params.id, {
          blastRadius: parsed.body.blastRadius,
        });
        repo.appendAuditEvent({
          context,
          workItemId: parsed.params.id,
          action: "spec.updated",
          metadata: { specId: saved.id, version: saved.version },
        });
        return saved;
      });
      putSpecRoute.respond(res, 200, { spec });
      return true;
    }
    if (listAgentRunsRoute.match(req.method, pathSegments)) {
      const parsed = await listAgentRunsRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      if (!repo.getWorkItem(context.organizationId, parsed.params.id)) {
        throw new DevFlowError(404, "not_found", "DevFlow work item not found.");
      }
      listAgentRunsRoute.respond(res, 200, {
        runs: repo.listAgentRuns(context.organizationId, parsed.params.id),
      });
      return true;
    }
    if (startAgentRunRoute.match(req.method, pathSegments)) {
      const parsed = await startAgentRunRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(req, res, "devflow.agent-run.start", actorId)) return true;
      const run = adapter.startAgentRun(context, parsed.params.id, parsed.body.mode);
      startAgentRunRoute.respond(res, 202, { runs: [run] });
      return true;
    }
    if (reconcileAgentRunRoute.match(req.method, pathSegments)) {
      const parsed = await reconcileAgentRunRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(req, res, "devflow.agent-run.start", actorId)) return true;
      const run = adapter.reconcileAgentRun(context, parsed.params.id);
      reconcileAgentRunRoute.respond(res, 200, { runs: [run] });
      return true;
    }
    if (listRepositoryTargetsRoute.match(req.method, pathSegments)) {
      listRepositoryTargetsRoute.respond(res, 200, {
        targets: repo.listRepositoryTargets(context.organizationId).map(publicRepositoryTarget),
      });
      return true;
    }
    if (createRepositoryTargetRoute.match(req.method, pathSegments)) {
      const parsed = await createRepositoryTargetRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(req, res, "devflow.factory.execute", actorId)) return true;
      const target = repo.createRepositoryTarget({
        organizationId: context.organizationId,
        ...parsed.body,
      });
      createRepositoryTargetRoute.respond(res, 201, {
        targets: [publicRepositoryTarget(target)],
      });
      return true;
    }
    if (listImplementationIntentsRoute.match(req.method, pathSegments)) {
      const parsed = await listImplementationIntentsRoute.parse(
        req,
        res,
        pathSegments,
        queryParams,
      );
      if (!parsed) return true;
      if (!repo.getWorkItem(context.organizationId, parsed.params.id)) {
        throw new DevFlowError(404, "not_found", "DevFlow work item not found.");
      }
      const intents = repo.listImplementationIntents(context.organizationId, parsed.params.id);
      listImplementationIntentsRoute.respond(res, 200, {
        intents,
        executions: intents.flatMap((intent) =>
          repo.listFactoryExecutions(context.organizationId, intent.id),
        ),
      });
      return true;
    }
    if (createImplementationIntentRoute.match(req.method, pathSegments)) {
      const parsed = await createImplementationIntentRoute.parse(
        req,
        res,
        pathSegments,
        queryParams,
      );
      if (!parsed || !ensurePermission(req, res, "devflow.factory.execute", actorId)) return true;
      const intent = intentService.create(context, parsed.params.id, parsed.body);
      const execution = factoryAdapter.startExecution(context, intent.id);
      createImplementationIntentRoute.respond(res, 202, {
        intents: [intent],
        executions: [execution],
      });
      return true;
    }
    if (getFactoryExecutionRoute.match(req.method, pathSegments)) {
      const parsed = await getFactoryExecutionRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      const execution = repo.getFactoryExecution(context.organizationId, parsed.params.id);
      if (!execution) {
        throw new DevFlowError(404, "factory_execution_not_found", "Factory execution not found.");
      }
      getFactoryExecutionRoute.respond(res, 200, { execution });
      return true;
    }
    if (reconcileFactoryExecutionRoute.match(req.method, pathSegments)) {
      const parsed = await reconcileFactoryExecutionRoute.parse(
        req,
        res,
        pathSegments,
        queryParams,
      );
      if (!parsed || !ensurePermission(req, res, "devflow.factory.execute", actorId)) return true;
      reconcileFactoryExecutionRoute.respond(res, 200, {
        execution: factoryAdapter.reconcileExecution(context, parsed.params.id),
      });
      return true;
    }
    const parsed = await getAuditRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!repo.getWorkItem(context.organizationId, parsed.params.id)) {
      throw new DevFlowError(404, "not_found", "DevFlow work item not found.");
    }
    getAuditRoute.respond(res, 200, {
      audit: repo.listAuditEvents(context.organizationId, parsed.params.id),
    });
    return true;
  } catch (error) {
    sendDevFlowError(res, error);
    return true;
  }
}
