import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  ChecklistError,
  listChecklist,
  mutateChecklist,
  userGrantCanEditSwarm,
} from "../be/checklist";
import { can } from "../rbac";
import { ChecklistItemSchema } from "../types";
import { resolveHttpFavoriteOwner } from "./favorite-owner";
import { resolveRequestPrincipal } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

const getChecklist = route({
  method: "get",
  path: "/api/checklist",
  pattern: ["api", "checklist"],
  summary: "Read the post-onboarding checklist",
  tags: ["Checklist"],
  responses: {
    200: {
      description: "Checklist items and swarm edit permission",
      schema: z.object({ items: z.array(ChecklistItemSchema), canEditSwarm: z.boolean() }),
    },
  },
});

const addChecklistItem = route({
  method: "post",
  path: "/api/checklist/items",
  pattern: ["api", "checklist", "items"],
  summary: "Add a checklist item",
  tags: ["Checklist"],
  rbac: { permission: "checklist.write.own" },
  body: z.object({
    kind: z.enum(["channel", "tool", "use_case", "custom"]),
    label: z.string().min(1).max(200),
    // An in-app path only: the dashboard renders it as a router link.
    href: z
      .string()
      .max(500)
      .regex(/^\/(?!\/)/, "href must be an in-app path starting with /")
      .optional(),
    scope: z.enum(["swarm", "user"]),
    // The dashboard sends `{ adapter }` for a channel item. The size cap keeps
    // free-form meta from the Lead small.
    meta: z
      .looseObject({ adapter: z.string().min(1).max(64).optional() })
      .refine((meta) => JSON.stringify(meta).length <= 1024, {
        message: "meta must be at most 1024 characters as JSON",
      })
      .optional(),
  }),
  responses: {
    201: { description: "Added checklist item", schema: z.object({ item: ChecklistItemSchema }) },
    400: { description: "A user is required for user items" },
    403: { description: "The caller cannot edit swarm items" },
    409: { description: "An open channel item for the same adapter already exists" },
  },
});

const patchChecklistItem = route({
  method: "patch",
  path: "/api/checklist/items/{id}",
  pattern: ["api", "checklist", "items", null],
  summary: "Update a checklist item",
  tags: ["Checklist"],
  rbac: { permission: "checklist.write.own" },
  params: z.object({ id: z.string() }),
  body: z
    .object({
      action: z.enum(["remove", "restore", "done", "reorder"]),
      reason: z.string().max(500).optional(),
      sortOrder: z.number().int().optional(),
    })
    .refine((body) => body.action !== "reorder" || body.sortOrder !== undefined, {
      message: "Reorder requires sortOrder",
      path: ["sortOrder"],
    }),
  responses: {
    200: { description: "Updated checklist item", schema: z.object({ item: ChecklistItemSchema }) },
    400: { description: "Invalid update" },
    403: { description: "The caller cannot edit this item" },
    404: { description: "Checklist item not found" },
  },
});

function decodePathId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function handleChecklist(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (
    !getChecklist.match(req.method, pathSegments) &&
    !addChecklistItem.match(req.method, pathSegments) &&
    !patchChecklistItem.match(req.method, pathSegments)
  )
    return false;
  const owner = await resolveHttpFavoriteOwner(req, myAgentId);
  if (!owner) {
    jsonError(res, "An authenticated principal is required", 401);
    return true;
  }
  const principal = await resolveRequestPrincipal(req, myAgentId, { precedence: "agent-first" });
  if (!principal) {
    jsonError(res, "An authenticated principal is required", 401);
    return true;
  }
  // Agents act on the checklist only as the Lead.
  if (
    principal.kind === "agent" &&
    !getChecklist.match(req.method, pathSegments) &&
    !can({ principal, verb: "checklist.write.agent", resource: { kind: "none" }, source: "http" })
      .allow
  ) {
    jsonError(res, "Only the Lead agent can change the checklist", 403);
    return true;
  }
  // The dashboard's selected user has the same grants as that user's token.
  // Role rows count only with RBAC on; off, the legacy policy decides.
  const grantAllows =
    principal.kind !== "agent" && owner.userId ? await userGrantCanEditSwarm(owner.userId) : null;
  const canEditSwarm =
    grantAllows ??
    (principal.kind === "operator" ||
      can({ principal, verb: "config.write.any", resource: { kind: "none" }, source: "http" })
        .allow);
  const actor = {
    id: principal.kind === "agent" ? `lead:${principal.agentId}` : owner.actorId,
    userId: owner.userId,
    canEditSwarm,
  };
  try {
    if (getChecklist.match(req.method, pathSegments)) {
      const parsed = await getChecklist.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      getChecklist.respond(res, 200, {
        items: await listChecklist(owner.userId, canEditSwarm),
        canEditSwarm,
      });
    } else if (addChecklistItem.match(req.method, pathSegments)) {
      const parsed = await addChecklistItem.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      addChecklistItem.respond(res, 201, {
        item: await mutateChecklist(actor, { action: "add", ...parsed.body }),
      });
    } else {
      const parsed = await patchChecklistItem.parse(req, res, pathSegments, queryParams);
      if (!parsed) return true;
      const { action, sortOrder, reason } = parsed.body;
      // Path segments arrive raw, and ids hold colons (`swarm:tool`) that clients may encode.
      const id = decodePathId(parsed.params.id);
      const item = await mutateChecklist(
        actor,
        action === "reorder" ? { action, id, sortOrder: sortOrder! } : { action, id, reason },
      );
      patchChecklistItem.respond(res, 200, { item });
    }
  } catch (error) {
    if (!(error instanceof ChecklistError)) throw error;
    jsonError(res, error.message, error.status);
  }
  return true;
}
