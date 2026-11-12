import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  applySheetOp,
  type EmbedActor,
  ObjectEmbedError,
  readObject,
  saveBoardContent,
} from "../be/primitives/object-embed";
import type { PrimitiveObject } from "../be/primitives/objects";
import { MAX_OBJECT_BYTES } from "../be/primitives/write-object";
import { findUserById } from "../be/users";
import { can } from "../rbac";
import { getRequestAuth } from "../utils/request-auth-context";
import { dashboardUserIdHeader } from "./favorite-owner";
import { authUser, isOperatorAuth, resolveRequestPrincipal } from "./request-principal";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

/**
 * Boards and sheets for people (an app's ObjectEmbed, a page's
 * `<swarm-object>`). Agents use the board-* and sheet-* tools instead.
 * The service (src/be/primitives/object-embed.ts) acts as the object's owner
 * agent on agent-fs; swarm RBAC (`objects.read`, `objects.write`) is the gate.
 */

const ObjectSchema = z.object({
  id: z.string(),
  kind: z.string(),
  orgId: z.string(),
  driveId: z.string(),
  path: z.string(),
  title: z.string().nullable(),
  fileVersion: z.number().nullable(),
  ownerAgentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  link: z.string().nullable(),
});

const params = z.object({ id: z.string().uuid().describe("Object id (`swarm.id` in the file)") });

const CellSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);
const CellRowsSchema = z.array(z.array(CellSchema));

const objectErrors = {
  400: { description: "Invalid input, or the object is not the kind this route edits" },
  403: {
    description:
      "Permission denied, a page guest, a read-only page session, or an object off the shared drive",
  },
  404: { description: "No such object, or its file is gone" },
  503: { description: "The owner agent has no agent-fs key on the object's drive" },
} as const;

const getObjectRoute = route({
  method: "get",
  path: "/api/objects/{id}",
  pattern: ["api", "objects", null],
  summary: "Read a board or sheet on the shared drive, or confirm it is unchanged",
  tags: ["Objects"],
  params,
  query: z.object({
    knownVersion: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("The version the caller holds. A match answers `unchanged: true` with no content"),
  }),
  rbac: { permission: "objects.read" },
  responses: {
    200: {
      description: "The object with its content, or `unchanged: true` with no content",
      schema: z.object({
        object: ObjectSchema,
        version: z.number().nullable(),
        unchanged: z.boolean(),
        content: z.unknown().optional(),
      }),
    },
    ...objectErrors,
  },
});

const putContentRoute = route({
  method: "put",
  path: "/api/objects/{id}/content",
  pattern: ["api", "objects", null, "content"],
  summary: "Save a board's full Excalidraw scene, guarded by its agent-fs version",
  tags: ["Objects"],
  params,
  body: z.object({
    content: z.record(z.string(), z.unknown()).describe("The Excalidraw scene"),
    ifMatch: z.number().int().min(0).describe("The version the scene was edited from"),
  }),
  // The scene is capped at 5 MiB as stored; the request may carry some slack.
  maxBodyBytes: MAX_OBJECT_BYTES + 256 * 1024,
  rbac: { permission: "objects.write" },
  responses: {
    200: {
      description: "Saved",
      schema: z.object({ object: ObjectSchema, version: z.number().nullable() }),
    },
    ...objectErrors,
    409: { description: "The board changed since `ifMatch`; the body carries its `version`" },
    413: { description: "The scene exceeds 5 MiB" },
  },
});

const sheetOpsRoute = route({
  method: "post",
  path: "/api/objects/{id}/sheet-ops",
  pattern: ["api", "objects", null, "sheet-ops"],
  summary: "Patch sheet cells; the server recalculates and merges concurrent edits",
  tags: ["Objects"],
  params,
  body: z.discriminatedUnion("op", [
    z.object({ op: z.literal("setRange"), range: z.string().min(1), values: CellRowsSchema }),
    z.object({ op: z.literal("clearRange"), range: z.string().min(1) }),
    z.object({ op: z.literal("appendRows"), tab: z.string().min(1), rows: CellRowsSchema }),
  ]),
  maxBodyBytes: 2 * 1024 * 1024,
  rbac: { permission: "objects.write" },
  responses: {
    200: {
      description: "Applied: the range written and the new version",
      schema: z.object({
        op: z.enum(["setRange", "clearRange", "appendRows"]),
        range: z.string(),
        version: z.number(),
        changed: z.number().optional(),
        recalculated: z.number().optional(),
        cleared: z.number().optional(),
      }),
    },
    ...objectErrors,
    409: { description: "Other writers changed the sheet on every retry; try again" },
  },
});

const publicObject = (o: PrimitiveObject): z.infer<typeof ObjectSchema> => ({
  id: o.id,
  kind: o.kind,
  orgId: o.orgId,
  driveId: o.driveId,
  path: o.path,
  title: o.title,
  fileVersion: o.fileVersion,
  ownerAgentId: o.ownerAgentId,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
  link: o.link,
});

/**
 * Check the verb and resolve who is acting. A password-page guest is refused
 * (the page proxy already refuses it; this covers a direct call), and a page
 * launched with the operator key may read but not write. Returns null after
 * the refusal is written.
 */
async function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
  verb: "objects.read" | "objects.write",
): Promise<EmbedActor | null> {
  const auth = getRequestAuth(req);
  if (auth?.kind === "guest" || auth?.kind === "controller") {
    jsonError(res, "sign in to the swarm to view this object", 403);
    return null;
  }
  const principal = await resolveRequestPrincipal(req, myAgentId, {
    unauthenticatedFallback: "operator",
  });
  const decision = principal
    ? can({ principal, verb, resource: { kind: "none" }, source: "http" })
    : { allow: false as const, reason: "no authenticated principal" };
  if (!decision.allow) {
    jsonError(res, decision.reason, 403);
    return null;
  }
  const via = auth?.page ? "page" : "app";
  if (verb === "objects.write" && auth?.page && principal?.kind !== "user") {
    jsonError(res, "this page session is read-only; sign in to the swarm to edit", 403);
    return null;
  }
  let user = principal?.kind === "user" ? authUser(auth) : undefined;
  // The dashboard sends the operator key plus the user it picked (as fs.ts does).
  if (!user && isOperatorAuth(auth) && !auth.page && !myAgentId) {
    const pickedId = dashboardUserIdHeader(req);
    const picked = pickedId ? await findUserById(pickedId) : null;
    if (picked?.status === "active" && !picked.mergedIntoUserId) user = picked;
  }
  return { via, userId: user?.id ?? null, name: user?.name ?? null };
}

function respondError(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof ObjectEmbedError)) return false;
  if (error.status === 409 && error.version !== undefined) {
    json(res, { error: error.message, version: error.version }, 409);
  } else {
    jsonError(res, error.message, error.status);
  }
  return true;
}

export async function handleObjects(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (getObjectRoute.match(req.method, pathSegments)) {
    const parsed = await getObjectRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await authorize(req, res, myAgentId, "objects.read"))) return true;
    try {
      const read = await readObject(parsed.params.id, parsed.query.knownVersion);
      getObjectRoute.respond(res, 200, { ...read, object: publicObject(read.object) });
    } catch (error) {
      if (!respondError(res, error)) throw error;
    }
    return true;
  }

  if (putContentRoute.match(req.method, pathSegments)) {
    const parsed = await putContentRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = await authorize(req, res, myAgentId, "objects.write");
    if (!actor) return true;
    try {
      const saved = await saveBoardContent({
        id: parsed.params.id,
        content: parsed.body.content,
        ifMatch: parsed.body.ifMatch,
        actor,
      });
      putContentRoute.respond(res, 200, { ...saved, object: publicObject(saved.object) });
    } catch (error) {
      if (!respondError(res, error)) throw error;
    }
    return true;
  }

  if (sheetOpsRoute.match(req.method, pathSegments)) {
    const parsed = await sheetOpsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const actor = await authorize(req, res, myAgentId, "objects.write");
    if (!actor) return true;
    try {
      sheetOpsRoute.respond(
        res,
        200,
        await applySheetOp({ id: parsed.params.id, op: parsed.body, actor }),
      );
    } catch (error) {
      if (!respondError(res, error)) throw error;
    }
    return true;
  }

  return false;
}
