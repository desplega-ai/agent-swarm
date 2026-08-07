import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { auditAssetKeys } from "../be/asset-key-audit";
import { AssetKeyAuthorizationError, authorizeAssetKeyWrite } from "../be/asset-key-auth";
import { resolveHttpAuditUserId } from "../be/audit-user";
import {
  getAgentById,
  getDb,
  getTaskById,
  listAssetSummaries,
  moveAssetKey,
  upsertAssetKeyMapping,
} from "../be/db";
import { can, type RbacPrincipal, type RbacResource } from "../rbac";
import {
  type AssetEntityType,
  AssetEntityTypeSchema,
  AssetKeyMappingSchema,
  AssetKeySchema,
  AssetSummarySchema,
} from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { jsonError } from "./utils";

const AssetKeyAuditIssueSchema = z.object({
  severity: z.enum(["fatal", "warning"]),
  code: z.enum([
    "missing-key",
    "noncanonical-key",
    "unknown-personal-user",
    "missing-provider-mapping",
    "provider-mapping-drift",
  ]),
  entityType: AssetEntityTypeSchema,
  entityId: z.string(),
  message: z.string(),
});

const AssetKeyAuditResultSchema = z.object({
  ok: z.boolean(),
  structuralValid: z.boolean(),
  checked: z.number().int().min(0),
  fatalCount: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  issues: z.array(AssetKeyAuditIssueSchema),
});

const keyAuditRoute = route({
  method: "get",
  path: "/api/assets/key-audit",
  pattern: ["api", "assets", "key-audit"],
  summary: "Audit asset namespace invariants",
  description:
    "Operator-only check for structural key validity, personal-user references, and logical provider mapping drift. Repeated logical keys are valid and are never reported as conflicts.",
  tags: ["Assets"],
  responses: {
    200: { description: "Asset namespace audit result", schema: AssetKeyAuditResultSchema },
    403: { description: "Operator access required" },
  },
});

const listAssetsRoute = route({
  method: "get",
  path: "/api/assets",
  pattern: ["api", "assets"],
  summary: "List lightweight cross-entity asset summaries",
  description:
    "Returns only entity type, ID, namespace key, label, update time, and optional provider reference. It never returns task briefs, page bodies, workflow definitions, secrets, or file bytes. Personal keys are namespace labels, not a privacy or read-visibility guarantee.",
  tags: ["Assets"],
  query: z.object({
    keyPrefix: AssetKeySchema.optional(),
    types: z.string().optional().describe("Comma-separated task,workflow,schedule,page,file list"),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  }),
  responses: {
    200: {
      description: "Lightweight asset summary list",
      schema: z.object({ assets: z.array(AssetSummarySchema), count: z.number().int() }),
    },
    400: { description: "Invalid entity type" },
  },
});

const registerMappingRoute = route({
  method: "post",
  path: "/api/assets/mappings",
  pattern: ["api", "assets", "mappings"],
  summary: "Register a logical namespace for a provider object",
  description:
    "Idempotently maps a provider tuple to a logical swarm key without moving, renaming, reading, or writing the remote object.",
  tags: ["Assets"],
  body: z.object({
    providerId: z.string().min(1),
    orgId: z.string().optional(),
    driveId: z.string().optional(),
    providerKey: z.string().min(1),
    key: AssetKeySchema.optional(),
  }),
  responses: {
    200: { description: "Mapping registered", schema: AssetKeyMappingSchema },
    400: { description: "Invalid provider tuple or namespace" },
    403: { description: "Operator access required or personal namespace not authorized" },
  },
  rbac: {
    ungated: "operator authentication is checked explicitly before provider metadata registration",
  },
});

function ensureOperator(req: IncomingMessage, res: ServerResponse): boolean {
  if (getRequestAuth(req)?.kind === "operator") return true;
  jsonError(res, "Operator access required", 403);
  return false;
}

const moveAssetRoute = route({
  method: "patch",
  path: "/api/assets/{entityType}/{id}/key",
  pattern: ["api", "assets", null, null, "key"],
  summary: "Move an asset to another logical namespace",
  description:
    "Updates namespace metadata only. Provider-backed files keep the same provider key, org, and drive; no remote move occurs. Personal keys are labels, not a privacy guarantee.",
  tags: ["Assets"],
  params: z.object({ entityType: AssetEntityTypeSchema, id: z.string().min(1) }),
  body: z.object({ key: AssetKeySchema }),
  responses: {
    200: {
      description: "Asset namespace updated",
      schema: z.object({
        entityType: AssetEntityTypeSchema,
        id: z.string(),
        key: AssetKeySchema,
      }),
    },
    400: { description: "Invalid namespace" },
    403: { description: "Move not authorized" },
    404: { description: "Asset not found" },
    409: { description: "Moves blocked until audit warnings are repaired" },
  },
  rbac: {
    ungated:
      "preserves each entity's current mutation posture; task moves additionally use task.fs.mutate, file moves require operator authentication, and personal destinations require a matching trusted user",
  },
});

function canMutateTaskNamespace(
  task: { id: string; agentId: string | null; creatorAgentId?: string },
  myAgentId: string | undefined,
  req: IncomingMessage,
): boolean {
  const resource: RbacResource = {
    kind: "task",
    taskId: task.id,
    agentId: task.agentId,
    creatorAgentId: task.creatorAgentId,
  };
  const auth = getRequestAuth(req);
  let principal: RbacPrincipal;
  if (auth?.kind === "operator") {
    principal = { kind: "operator" };
  } else if (auth?.kind === "user") {
    principal = { kind: "user", userId: auth.userId };
  } else {
    if (!myAgentId) return false;
    const agent = getAgentById(myAgentId);
    principal = { kind: "agent", agentId: myAgentId, isLead: agent?.isLead ?? false };
  }
  return can({ principal, verb: "task.fs.mutate", resource, source: "http" }).allow;
}

export async function handleAssets(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (keyAuditRoute.match(req.method, pathSegments)) {
    const parsed = await keyAuditRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureOperator(req, res)) return true;
    keyAuditRoute.respond(res, 200, auditAssetKeys(getDb()));
    return true;
  }

  if (listAssetsRoute.match(req.method, pathSegments)) {
    const parsed = await listAssetsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const types: AssetEntityType[] = [];
    for (const token of parsed.query.types?.split(",").map((value) => value.trim()) ?? []) {
      if (!token) continue;
      const result = AssetEntityTypeSchema.safeParse(token);
      if (!result.success) {
        jsonError(res, `Invalid asset entity type: ${token}`, 400);
        return true;
      }
      types.push(result.data);
    }
    const assets = listAssetSummaries({
      keyPrefix: parsed.query.keyPrefix,
      types: types.length > 0 ? types : undefined,
      limit: parsed.query.limit,
    });
    listAssetsRoute.respond(res, 200, { assets, count: assets.length });
    return true;
  }

  if (registerMappingRoute.match(req.method, pathSegments)) {
    const parsed = await registerMappingRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!ensureOperator(req, res)) return true;
    try {
      const actor = resolveHttpAuditUserId(req, myAgentId);
      const key = parsed.body.key ? authorizeAssetKeyWrite(parsed.body.key, actor) : undefined;
      const mapping = upsertAssetKeyMapping({
        providerId: parsed.body.providerId,
        providerOrgId: parsed.body.orgId,
        providerDriveId: parsed.body.driveId,
        providerKey: parsed.body.providerKey,
        key,
        createdBy: actor ?? undefined,
        updatedBy: actor ?? undefined,
      });
      registerMappingRoute.respond(res, 200, mapping);
    } catch (error) {
      if (error instanceof AssetKeyAuthorizationError) {
        jsonError(res, error.message, error.statusCode);
        return true;
      }
      jsonError(res, error instanceof Error ? error.message : String(error), 400);
    }
    return true;
  }

  if (moveAssetRoute.match(req.method, pathSegments)) {
    const parsed = await moveAssetRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (parsed.params.entityType === "file" && !ensureOperator(req, res)) return true;
    if (parsed.params.entityType === "task") {
      const task = getTaskById(parsed.params.id);
      if (!task) {
        jsonError(res, "Asset not found", 404);
        return true;
      }
      if (!canMutateTaskNamespace(task, myAgentId, req)) {
        jsonError(res, "Not authorized to move this task namespace", 403);
        return true;
      }
    }

    try {
      const actor = resolveHttpAuditUserId(req, myAgentId);
      const key = authorizeAssetKeyWrite(parsed.body.key, actor);
      const moved = moveAssetKey({
        entityType: parsed.params.entityType,
        id: parsed.params.id,
        key,
        changedBy: actor ?? undefined,
      });
      if (!moved) {
        jsonError(res, "Asset not found", 404);
        return true;
      }
      moveAssetRoute.respond(res, 200, {
        entityType: parsed.params.entityType,
        id: parsed.params.id,
        key,
      });
    } catch (error) {
      if (error instanceof AssetKeyAuthorizationError) {
        jsonError(res, error.message, error.statusCode);
        return true;
      }
      const message = error instanceof Error ? error.message : String(error);
      jsonError(res, message, message.includes("blocked until") ? 409 : 400);
    }
    return true;
  }

  return false;
}
