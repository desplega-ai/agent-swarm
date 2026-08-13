import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  AriaHqErrorResponseSchema,
  ClientIntakesResponseSchema,
  CreateEngineDraftBodySchema,
  CreateKnowledgeSourceBodySchema,
  CreateSlackSurfaceBodySchema,
  EngineCatalogResponseSchema,
  EngineDraftResponseSchema,
  EngineVersionResponseSchema,
  IngestKnowledgeBodySchema,
  KnowledgeAnswerResponseSchema,
  KnowledgeRecordResponseSchema,
  KnowledgeSearchBodySchema,
  KnowledgeSourceProvisionResponseSchema,
  KnowledgeSourcesResponseSchema,
  KnowledgeSourceWebhookBodySchema,
  KnowledgeSourceWebhookResponseSchema,
  SlackSurfacesResponseSchema,
} from "../ariahq/api/schemas";
import type { AriaHqContext } from "../ariahq/domain/types";
import { createAriaHqRepository } from "../ariahq/repository";
import { createEngineBuilder } from "../ariahq/services/engine-builder";
import { createKnowledgeService } from "../ariahq/services/knowledge-service";
import { verifySlackSurface } from "../ariahq/services/slack-surface-verifier";
import { createScheduledTask, getAgentById, getDb } from "../be/db";
import { listScriptConnections } from "../be/script-connections";
import { getScript } from "../be/scripts/db";
import { createDevFlowRepository } from "../devflow/repository";
import { can, type PermissionVerb } from "../rbac";
import { calculateNextRun } from "../scheduler/scheduler";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";

const errors = {
  403: { description: "Forbidden", schema: AriaHqErrorResponseSchema },
  404: { description: "Not found", schema: AriaHqErrorResponseSchema },
  409: { description: "Conflict", schema: AriaHqErrorResponseSchema },
  422: { description: "Invalid request", schema: AriaHqErrorResponseSchema },
} as const;

const listEnginesRoute = route({
  method: "get",
  path: "/api/ariahq/v1/engine-drafts",
  pattern: ["api", "ariahq", "v1", "engine-drafts"],
  summary: "List AriaHQ engine drafts and published versions",
  tags: ["AriaHQ"],
  responses: {
    200: { description: "Engine catalog", schema: EngineCatalogResponseSchema },
    ...errors,
  },
  auth: { apiKey: true },
});

const createDraftRoute = route({
  method: "post",
  path: "/api/ariahq/v1/engine-drafts",
  pattern: ["api", "ariahq", "v1", "engine-drafts"],
  summary: "Start a governed AriaHQ engine draft",
  tags: ["AriaHQ"],
  body: CreateEngineDraftBodySchema,
  responses: {
    202: { description: "Draft task started", schema: EngineDraftResponseSchema },
    ...errors,
  },
  auth: { apiKey: true },
  rbac: { permission: "ariahq.engine.manage" },
});

const reconcileDraftRoute = route({
  method: "post",
  path: "/api/ariahq/v1/engine-drafts/{id}/reconcile",
  pattern: ["api", "ariahq", "v1", "engine-drafts", null, "reconcile"],
  summary: "Reconcile an AriaHQ engine drafting task",
  tags: ["AriaHQ"],
  params: z.object({ id: z.string().uuid() }),
  body: z.object({}),
  responses: {
    200: { description: "Reconciled draft", schema: EngineDraftResponseSchema },
    ...errors,
  },
  auth: { apiKey: true },
  rbac: { permission: "ariahq.engine.manage" },
});

const publishDraftRoute = route({
  method: "post",
  path: "/api/ariahq/v1/engine-drafts/{id}/publish",
  pattern: ["api", "ariahq", "v1", "engine-drafts", null, "publish"],
  summary: "Publish a validated AriaHQ engine contract",
  tags: ["AriaHQ"],
  params: z.object({ id: z.string().uuid() }),
  body: z.object({}),
  responses: {
    201: { description: "Published engine", schema: EngineVersionResponseSchema },
    ...errors,
  },
  auth: { apiKey: true },
  rbac: { permission: "ariahq.engine.manage" },
});

const ingestKnowledgeRoute = route({
  method: "post",
  path: "/api/ariahq/v1/knowledge/records",
  pattern: ["api", "ariahq", "v1", "knowledge", "records"],
  summary: "Ingest a versioned AriaHQ knowledge record",
  tags: ["AriaHQ"],
  body: IngestKnowledgeBodySchema,
  responses: {
    201: { description: "Knowledge record", schema: KnowledgeRecordResponseSchema },
    ...errors,
  },
  auth: { apiKey: true },
  rbac: { permission: "ariahq.knowledge.write" },
});

const searchKnowledgeRoute = route({
  method: "post",
  path: "/api/ariahq/v1/knowledge/search",
  pattern: ["api", "ariahq", "v1", "knowledge", "search"],
  summary: "Ask Aria using source-backed organizational evidence",
  tags: ["AriaHQ"],
  body: KnowledgeSearchBodySchema,
  responses: {
    200: { description: "Answer task and evidence bundle", schema: KnowledgeAnswerResponseSchema },
    ...errors,
  },
  auth: { apiKey: true },
  rbac: { ungated: "Authenticated organization members may query internal knowledge." },
});

const listKnowledgeSourcesRoute = route({
  method: "get",
  path: "/api/ariahq/v1/knowledge-sources",
  pattern: ["api", "ariahq", "v1", "knowledge-sources"],
  summary: "List tenant-scoped AriaHQ knowledge sources",
  tags: ["AriaHQ"],
  responses: {
    200: { description: "Knowledge sources", schema: KnowledgeSourcesResponseSchema },
    ...errors,
  },
  auth: { apiKey: true },
});

const createKnowledgeSourceRoute = route({
  method: "post",
  path: "/api/ariahq/v1/knowledge-sources",
  pattern: ["api", "ariahq", "v1", "knowledge-sources"],
  summary: "Provision a tenant-scoped AriaHQ knowledge source and optional schedule",
  tags: ["AriaHQ"],
  body: CreateKnowledgeSourceBodySchema,
  responses: {
    201: {
      description: "Provisioned knowledge source",
      schema: KnowledgeSourceProvisionResponseSchema,
    },
    ...errors,
  },
  auth: { apiKey: true },
  rbac: { permission: "ariahq.knowledge.write" },
});

const knowledgeSourceWebhookRoute = route({
  method: "post",
  path: "/api/ariahq/v1/knowledge-sources/{id}/webhook",
  pattern: ["api", "ariahq", "v1", "knowledge-sources", null, "webhook"],
  summary: "Push normalized evidence into an authenticated AriaHQ webhook source",
  tags: ["AriaHQ"],
  params: z.object({ id: z.string().uuid() }),
  body: KnowledgeSourceWebhookBodySchema,
  responses: {
    202: { description: "Webhook evidence accepted", schema: KnowledgeSourceWebhookResponseSchema },
    ...errors,
  },
  auth: { apiKey: false },
  rbac: { ungated: "A high-entropy per-source webhook secret authenticates this endpoint." },
});

const listSurfacesRoute = route({
  method: "get",
  path: "/api/ariahq/v1/slack-surfaces",
  pattern: ["api", "ariahq", "v1", "slack-surfaces"],
  summary: "List AriaHQ Slack surfaces",
  tags: ["AriaHQ"],
  responses: {
    200: { description: "Slack surfaces", schema: SlackSurfacesResponseSchema },
    ...errors,
  },
  auth: { apiKey: true },
});

const createSurfaceRoute = route({
  method: "post",
  path: "/api/ariahq/v1/slack-surfaces",
  pattern: ["api", "ariahq", "v1", "slack-surfaces"],
  summary: "Configure an AriaHQ Slack surface",
  tags: ["AriaHQ"],
  body: CreateSlackSurfaceBodySchema,
  responses: {
    201: { description: "Slack surface", schema: SlackSurfacesResponseSchema },
    ...errors,
  },
  auth: { apiKey: true },
  rbac: { permission: "ariahq.surface.manage" },
});

const verifySurfaceRoute = route({
  method: "post",
  path: "/api/ariahq/v1/slack-surfaces/{id}/verify",
  pattern: ["api", "ariahq", "v1", "slack-surfaces", null, "verify"],
  summary: "Verify Aria's workspace and channel access for a Slack surface",
  tags: ["AriaHQ"],
  params: z.object({ id: z.string().uuid() }),
  body: z.object({}),
  responses: {
    200: { description: "Verified Slack surface", schema: SlackSurfacesResponseSchema },
    ...errors,
  },
  auth: { apiKey: true },
  rbac: { permission: "ariahq.surface.manage" },
});

const listIntakesRoute = route({
  method: "get",
  path: "/api/ariahq/v1/client-intakes",
  pattern: ["api", "ariahq", "v1", "client-intakes"],
  summary: "List tenant-scoped client intake projections",
  tags: ["AriaHQ"],
  responses: {
    200: { description: "Client intakes", schema: ClientIntakesResponseSchema },
    ...errors,
  },
  auth: { apiKey: true },
});

function oneHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function resolveContext(req: IncomingMessage): { context: AriaHqContext; userId: string } {
  const devflow = createDevFlowRepository(getDb());
  const auth = getRequestAuth(req);
  const userId = auth?.kind === "user" ? auth.userId : oneHeader(req, "x-devflow-user-id");
  if (!userId) throw new Error("AriaHQ requires a user identity");
  const selected = oneHeader(req, "x-devflow-organization-id");
  const membership = selected
    ? devflow.getMembership(selected, userId)
    : devflow.findMembershipForUser(userId);
  if (!membership) throw new Error("AriaHQ requires membership in the selected organization");
  return {
    userId,
    context: {
      organizationId: membership.organizationId,
      actorKind: "user",
      actorId: userId,
      audience: "internal",
    },
  };
}

function ensurePermission(res: ServerResponse, verb: PermissionVerb, userId: string): boolean {
  const decision = can({
    principal: { kind: "user", userId },
    verb,
    resource: { kind: "none" },
    source: "http",
  });
  if (decision.allow) return true;
  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: decision.reason, error_code: "insufficient_permission" }));
  return false;
}

function sendError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : "AriaHQ request failed";
  const status = /not found/i.test(message)
    ? 404
    : /requires|permission/i.test(message)
      ? 403
      : 422;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ error: message, error_code: status === 404 ? "not_found" : "request_failed" }),
  );
}

export async function handleAriaHq(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  const routes = [
    listEnginesRoute,
    createDraftRoute,
    reconcileDraftRoute,
    publishDraftRoute,
    ingestKnowledgeRoute,
    searchKnowledgeRoute,
    listKnowledgeSourcesRoute,
    createKnowledgeSourceRoute,
    knowledgeSourceWebhookRoute,
    listSurfacesRoute,
    createSurfaceRoute,
    verifySurfaceRoute,
    listIntakesRoute,
  ];
  if (!routes.some((candidate) => candidate.match(req.method, pathSegments))) return false;
  try {
    if (knowledgeSourceWebhookRoute.match(req.method, pathSegments)) {
      const parsed = await knowledgeSourceWebhookRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      const secret = oneHeader(req, "x-ariahq-webhook-secret");
      const deny = () => {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Webhook source authentication failed",
            error_code: "invalid_webhook_secret",
          }),
        );
      };
      if (!secret || secret.length < 32) {
        deny();
        return true;
      }
      const repo = createAriaHqRepository(getDb());
      const secretHash = createHash("sha256").update(secret).digest("hex");
      const source = repo.getWebhookKnowledgeSource(parsed.params.id, secretHash);
      if (!source) {
        deny();
        return true;
      }
      const started = repo.beginKnowledgeSync(source.id, source.runAsAgentId);
      const run = repo.completeKnowledgeSync({
        sourceId: source.id,
        runId: started.id,
        agentId: source.runAsAgentId,
        records: parsed.body.records,
        ...(parsed.body.nextCursor === undefined ? {} : { nextCursor: parsed.body.nextCursor }),
      });
      knowledgeSourceWebhookRoute.respond(res, 202, { run });
      return true;
    }

    const { context, userId } = resolveContext(req);
    const repo = createAriaHqRepository(getDb());
    const builder = createEngineBuilder({ repo });
    const knowledge = createKnowledgeService({ repo });

    if (listEnginesRoute.match(req.method, pathSegments)) {
      listEnginesRoute.respond(res, 200, {
        drafts: repo.listEngineDrafts(context.organizationId),
        engines: repo.listEngineVersions(context.organizationId),
      });
      return true;
    }
    if (createDraftRoute.match(req.method, pathSegments)) {
      const parsed = await createDraftRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(res, "ariahq.engine.manage", userId)) return true;
      createDraftRoute.respond(res, 202, { draft: builder.startDraft(context, parsed.body) });
      return true;
    }
    if (reconcileDraftRoute.match(req.method, pathSegments)) {
      const parsed = await reconcileDraftRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(res, "ariahq.engine.manage", userId)) return true;
      reconcileDraftRoute.respond(res, 200, {
        draft: builder.reconcileDraft(context, parsed.params.id),
      });
      return true;
    }
    if (publishDraftRoute.match(req.method, pathSegments)) {
      const parsed = await publishDraftRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(res, "ariahq.engine.manage", userId)) return true;
      publishDraftRoute.respond(res, 201, {
        engine: builder.publishDraft(context, parsed.params.id),
      });
      return true;
    }
    if (ingestKnowledgeRoute.match(req.method, pathSegments)) {
      const parsed = await ingestKnowledgeRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(res, "ariahq.knowledge.write", userId)) return true;
      ingestKnowledgeRoute.respond(res, 201, {
        record: repo.ingestKnowledge({
          organizationId: context.organizationId,
          ...parsed.body,
          createdByUserId: userId,
        }),
      });
      return true;
    }
    if (searchKnowledgeRoute.match(req.method, pathSegments)) {
      const parsed = await searchKnowledgeRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      searchKnowledgeRoute.respond(
        res,
        200,
        knowledge.startAnswer(context, parsed.body.question, { limit: parsed.body.limit }),
      );
      return true;
    }
    if (listKnowledgeSourcesRoute.match(req.method, pathSegments)) {
      listKnowledgeSourcesRoute.respond(res, 200, {
        sources: repo.listKnowledgeSources(context.organizationId),
      });
      return true;
    }
    if (createKnowledgeSourceRoute.match(req.method, pathSegments)) {
      const parsed = await createKnowledgeSourceRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(res, "ariahq.knowledge.write", userId)) return true;
      if (!getAgentById(parsed.body.runAsAgentId)) {
        throw new Error("Knowledge source run-as agent not found");
      }
      if (parsed.body.adapter === "openapi") {
        const connection = listScriptConnections({
          agentId: parsed.body.runAsAgentId,
          kind: "openapi",
        }).find((candidate) => candidate.slug === parsed.body.connectionSlug);
        if (!connection)
          throw new Error("Knowledge source connection is unavailable to its run-as agent");
        if (connection.generationError || !connection.generatedRuntimeJson) {
          throw new Error("Knowledge source connection is not ready for execution");
        }
        if (!getScript({ name: "ariahq-knowledge-sync", scope: "global" })) {
          throw new Error("AriaHQ knowledge sync script is not installed");
        }
      }

      const webhookSecret =
        parsed.body.adapter === "webhook" ? randomBytes(32).toString("base64url") : undefined;
      const provisioned = repo.transaction(() => {
        let source = repo.createKnowledgeSource({
          organizationId: context.organizationId,
          key: parsed.body.key,
          name: parsed.body.name,
          sourceKind: parsed.body.sourceKind,
          audience: parsed.body.audience,
          ...(parsed.body.clientKey ? { clientKey: parsed.body.clientKey } : {}),
          adapter: parsed.body.adapter,
          ...(parsed.body.connectionSlug ? { connectionSlug: parsed.body.connectionSlug } : {}),
          runAsAgentId: parsed.body.runAsAgentId,
          syncConfig: parsed.body.syncConfig,
          ...(webhookSecret
            ? {
                webhookSecretHash: createHash("sha256").update(webhookSecret).digest("hex"),
              }
            : {}),
          createdByUserId: userId,
        });
        if (!parsed.body.schedule) return { source, ...(webhookSecret ? { webhookSecret } : {}) };
        const timing = {
          cronExpression: parsed.body.schedule.cronExpression ?? null,
          intervalMs: parsed.body.schedule.intervalMs ?? null,
          timezone: parsed.body.schedule.timezone,
        };
        const schedule = createScheduledTask({
          name: `AriaHQ source: ${context.organizationId}/${parsed.body.key}`,
          description: `Synchronize ${parsed.body.name} into the AriaHQ Organizational Brain.`,
          ...(parsed.body.schedule.cronExpression
            ? { cronExpression: parsed.body.schedule.cronExpression }
            : {}),
          ...(parsed.body.schedule.intervalMs
            ? { intervalMs: parsed.body.schedule.intervalMs }
            : {}),
          timezone: parsed.body.schedule.timezone,
          enabled: parsed.body.schedule.enabled,
          nextRunAt: parsed.body.schedule.enabled
            ? calculateNextRun(timing as Parameters<typeof calculateNextRun>[0])
            : undefined,
          targetType: "script",
          targetAgentId: parsed.body.runAsAgentId,
          scriptName: "ariahq-knowledge-sync",
          scriptArgs: { sourceId: source.id },
          tags: ["ariahq", "knowledge-source", parsed.body.sourceKind],
          createdBy: userId,
        });
        source = repo.attachKnowledgeSourceSchedule(
          context.organizationId,
          source.id,
          schedule.id,
          userId,
        );
        return { source, schedule };
      });
      createKnowledgeSourceRoute.respond(res, 201, provisioned);
      return true;
    }
    if (listSurfacesRoute.match(req.method, pathSegments)) {
      listSurfacesRoute.respond(res, 200, {
        surfaces: repo.listSlackSurfaces(context.organizationId),
      });
      return true;
    }
    if (createSurfaceRoute.match(req.method, pathSegments)) {
      const parsed = await createSurfaceRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(res, "ariahq.surface.manage", userId)) return true;
      const devflow = createDevFlowRepository(getDb());
      if (!devflow.getMembership(context.organizationId, parsed.body.pmOwnerId)) {
        throw new Error("PM owner must belong to the selected organization");
      }
      let surface = repo.createSlackSurface({
        organizationId: context.organizationId,
        ...parsed.body,
        createdByUserId: userId,
      });
      const verification = await verifySlackSurface({
        workspaceId: surface.workspaceId,
        channelId: surface.channelId,
      });
      surface = repo.setSlackSurfaceVerification(
        context.organizationId,
        surface.id,
        verification,
        userId,
      );
      createSurfaceRoute.respond(res, 201, {
        surfaces: [surface],
      });
      return true;
    }
    if (verifySurfaceRoute.match(req.method, pathSegments)) {
      const parsed = await verifySurfaceRoute.parse(req, res, pathSegments, queryParams);
      if (!parsed || !ensurePermission(res, "ariahq.surface.manage", userId)) return true;
      const surface = repo
        .listSlackSurfaces(context.organizationId)
        .find((candidate) => candidate.id === parsed.params.id);
      if (!surface) throw new Error("AriaHQ Slack surface not found");
      const verification = await verifySlackSurface({
        workspaceId: surface.workspaceId,
        channelId: surface.channelId,
      });
      verifySurfaceRoute.respond(res, 200, {
        surfaces: [
          repo.setSlackSurfaceVerification(
            context.organizationId,
            surface.id,
            verification,
            userId,
          ),
        ],
      });
      return true;
    }
    listIntakesRoute.respond(res, 200, {
      intakes: repo.listClientIntakes(context.organizationId),
    });
    return true;
  } catch (error) {
    sendError(res, error);
    return true;
  }
}
