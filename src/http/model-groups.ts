// Model groups CRUD (runbooks/model-tiers.md § Model groups).
//
// A group is a named, ordered list of model profiles that may span harnesses.
// Boot seeds the four tier groups (smol, regular, smart, ultra). Nothing
// resolves a task through a group yet. Reads are open to every caller; writes
// need `models.groups.write` (the lead, the operator or a dashboard user).

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpAuditUserId } from "../be/audit-user";
import {
  createModelGroup,
  deleteModelGroup,
  getModelGroupByName,
  listModelGroups,
  MAX_MODEL_GROUP_MEMBERS,
  type ModelGroupWriteResult,
  modelGroupReferences,
  updateModelGroup,
} from "../be/db/model-groups";
import { can } from "../rbac";
import { ModelGroupSchema, ModelProfileNameSchema } from "../types";
import { agentFirstPrincipal } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

const MembersSchema = z
  .array(ModelProfileNameSchema)
  .min(1)
  .max(MAX_MODEL_GROUP_MEMBERS)
  .describe("Profile names in preference order, first preferred. Any harness; no repeats.");

const listGroups = route({
  method: "get",
  path: "/api/model-groups",
  pattern: ["api", "model-groups"],
  summary: "List model groups",
  description: "Every model group with its member profiles in order, by name.",
  tags: ["Models"],
  responses: {
    200: { description: "Model groups", schema: z.object({ groups: z.array(ModelGroupSchema) }) },
  },
});

const getGroup = route({
  method: "get",
  path: "/api/model-groups/{name}",
  pattern: ["api", "model-groups", null],
  summary: "Get one model group",
  tags: ["Models"],
  params: z.object({ name: z.string() }),
  responses: {
    200: { description: "The model group", schema: ModelGroupSchema },
    404: { description: "No group with that name" },
  },
});

const createGroup = route({
  method: "post",
  path: "/api/model-groups",
  pattern: ["api", "model-groups"],
  summary: "Create a model group",
  description:
    "A group is an ordered list of model profiles that may span harnesses. Every member must be an existing profile, listed once. The name may not be a model profile's (groups and profiles share one name space; 409). Lead, operator or dashboard user.",
  tags: ["Models"],
  rbac: { permission: "models.groups.write" },
  body: z.object({
    name: ModelProfileNameSchema,
    description: z.string().trim().max(500).nullable().optional(),
    members: MembersSchema,
  }),
  responses: {
    201: { description: "Group created", schema: ModelGroupSchema },
    400: { description: "Validation error" },
    403: { description: "Forbidden" },
    409: { description: "A group or profile with that name exists" },
  },
});

const updateGroup = route({
  method: "patch",
  path: "/api/model-groups/{name}",
  pattern: ["api", "model-groups", null],
  summary: "Update a model group",
  description:
    "Changes the description (`null` clears it). The name is fixed; reorder or replace members with `PUT /api/model-groups/{name}/members`. Lead, operator or dashboard user.",
  tags: ["Models"],
  rbac: { permission: "models.groups.write" },
  params: z.object({ name: z.string() }),
  body: z.object({ description: z.string().trim().max(500).nullable() }),
  responses: {
    200: { description: "Group updated", schema: ModelGroupSchema },
    400: { description: "Validation error" },
    403: { description: "Forbidden" },
    404: { description: "No group with that name" },
  },
});

const setMembers = route({
  method: "put",
  path: "/api/model-groups/{name}/members",
  pattern: ["api", "model-groups", null, "members"],
  summary: "Replace a model group's members",
  description:
    "Replaces the whole ordered member list in one transaction; send the full list to reorder. Every member must be an existing profile, listed once. Lead, operator or dashboard user.",
  tags: ["Models"],
  rbac: { permission: "models.groups.write" },
  params: z.object({ name: z.string() }),
  body: z.object({ members: MembersSchema }),
  responses: {
    200: { description: "Members replaced", schema: ModelGroupSchema },
    400: { description: "Validation error" },
    403: { description: "Forbidden" },
    404: { description: "No group with that name" },
  },
});

const deleteGroup = route({
  method: "delete",
  path: "/api/model-groups/{name}",
  pattern: ["api", "model-groups", null],
  summary: "Delete a model group",
  description:
    "Refused (409) for a shipped tier group (`smol`, `regular`, `smart`, `ultra`; edit it instead, it would come back at the next boot), and while a schedule names the group or a task holds it (unfinished, or superseded and still owed its resume). Lead, operator or dashboard user.",
  tags: ["Models"],
  rbac: { permission: "models.groups.write" },
  params: z.object({ name: z.string() }),
  responses: {
    200: { description: "Group deleted", schema: z.object({ deleted: z.literal(true) }) },
    403: { description: "Forbidden" },
    404: { description: "No group with that name" },
    409: { description: "The group is a seed or still in use" },
  },
});

/** Gate a write on `models.groups.write`; writes a 403 and returns false on denial. */
async function canWriteGroups(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
): Promise<boolean> {
  const decision = can({
    principal: await agentFirstPrincipal(req, myAgentId),
    verb: "models.groups.write",
    resource: { kind: "none" },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(res, "Writing model groups requires the lead, the operator or a dashboard user", 403);
    return false;
  }
  return true;
}

const WRITE_FAILURE_STATUS = { invalid: 400, exists: 409, "name-taken": 409, missing: 404 };

/** Send a failed write's status and message; true when the write failed. */
function writeFailed(
  res: ServerResponse,
  result: ModelGroupWriteResult,
): result is Extract<ModelGroupWriteResult, { ok: false }> {
  if (result.ok) return false;
  jsonError(res, result.error, WRITE_FAILURE_STATUS[result.reason]);
  return true;
}

export async function handleModelGroups(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (listGroups.match(req.method, pathSegments)) {
    const parsed = await listGroups.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    listGroups.respond(res, 200, { groups: await listModelGroups() });
    return true;
  }

  if (getGroup.match(req.method, pathSegments)) {
    const parsed = await getGroup.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const group = await getModelGroupByName(parsed.params.name);
    if (!group) {
      jsonError(res, "Model group not found", 404);
      return true;
    }
    getGroup.respond(res, 200, group);
    return true;
  }

  if (createGroup.match(req.method, pathSegments)) {
    const parsed = await createGroup.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await canWriteGroups(req, res, myAgentId))) return true;
    const userId = await resolveHttpAuditUserId(req, myAgentId);
    const result = await createModelGroup(parsed.body, { userId });
    if (writeFailed(res, result)) return true;
    createGroup.respond(res, 201, result.group);
    return true;
  }

  if (updateGroup.match(req.method, pathSegments)) {
    const parsed = await updateGroup.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await canWriteGroups(req, res, myAgentId))) return true;
    const userId = await resolveHttpAuditUserId(req, myAgentId);
    const result = await updateModelGroup(
      parsed.params.name,
      { description: parsed.body.description },
      { userId },
    );
    if (writeFailed(res, result)) return true;
    updateGroup.respond(res, 200, result.group);
    return true;
  }

  if (setMembers.match(req.method, pathSegments)) {
    const parsed = await setMembers.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await canWriteGroups(req, res, myAgentId))) return true;
    const userId = await resolveHttpAuditUserId(req, myAgentId);
    const result = await updateModelGroup(
      parsed.params.name,
      { members: parsed.body.members },
      { userId },
    );
    if (writeFailed(res, result)) return true;
    setMembers.respond(res, 200, result.group);
    return true;
  }

  if (deleteGroup.match(req.method, pathSegments)) {
    const parsed = await deleteGroup.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await canWriteGroups(req, res, myAgentId))) return true;
    const current = await getModelGroupByName(parsed.params.name);
    if (!current) {
      jsonError(res, "Model group not found", 404);
      return true;
    }
    if (current.seededFrom?.startsWith("tier:")) {
      jsonError(
        res,
        `"${current.name}" is a shipped tier group and comes back at the next boot; edit it instead.`,
        409,
      );
      return true;
    }
    const refs = await modelGroupReferences(current.name);
    if (refs.openTaskCount > 0 || refs.scheduleIds.length > 0) {
      const schedules = refs.scheduleIds.length > 0 ? ` (${refs.scheduleIds.join(", ")})` : "";
      jsonError(
        res,
        `"${current.name}" is in use: held by ${refs.openTaskCount} unfinished or awaiting-resume task(s), named by ${refs.scheduleIds.length} schedule(s)${schedules}.`,
        409,
      );
      return true;
    }
    // The counts above are for the message; the delete re-checks in the same
    // statement, so a reference written since is still a 409.
    const outcome = await deleteModelGroup(current.name);
    if (outcome === "in-use") {
      jsonError(res, `"${current.name}" is in use by a task or a schedule written just now.`, 409);
      return true;
    }
    if (outcome === "missing") {
      jsonError(res, "Model group not found", 404);
      return true;
    }
    deleteGroup.respond(res, 200, { deleted: true });
    return true;
  }

  return false;
}
