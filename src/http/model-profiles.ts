// Model profiles CRUD (runbooks/model-tiers.md § Model profiles).
//
// A profile is a named harness + model + optional effort. Lead picks one per
// task (`profile` on send-task / POST /api/tasks) or sets it as an agent's
// default (PATCH /api/agents/{id}/runtime { profile }); claim resolves it.
// Reads are open to every caller; writes are operator-only (`models.profiles.write`).

import type { IncomingMessage, ServerResponse } from "node:http";
import { isAlias } from "@desplega/model-catalog";
import { z } from "zod";
import { resolveHttpAuditUserId } from "../be/audit-user";
import {
  createModelProfile,
  deleteModelProfile,
  getModelProfileByName,
  listModelProfiles,
  modelProfileReferences,
  updateModelProfile,
} from "../be/db/model-profiles";
import { explicitModelError } from "../be/model-validation";
import { supportedReasoningLevels } from "../providers/reasoning-effort";
import { can } from "../rbac";
import {
  type ModelProfileCredentials,
  ModelProfileCredentialsSchema,
  ModelProfileNameSchema,
  ModelProfileSchema,
  type ProviderName,
  ProviderNameSchema,
  type ReasoningEffort,
  ReasoningEffortSchema,
} from "../types";
import { getModelAwareCredentialVars, PROVIDER_CREDENTIAL_VARS } from "../utils/credentials";
import { agentFirstPrincipal } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

const listProfiles = route({
  method: "get",
  path: "/api/model-profiles",
  pattern: ["api", "model-profiles"],
  summary: "List model profiles",
  description:
    "Every model profile, ordered by harness then name. Filter by `harness` to see what an agent on that harness can run.",
  tags: ["Models"],
  query: z.object({ harness: ProviderNameSchema.optional() }),
  responses: {
    200: {
      description: "Model profiles",
      schema: z.object({ profiles: z.array(ModelProfileSchema) }),
    },
  },
});

const getProfile = route({
  method: "get",
  path: "/api/model-profiles/{name}",
  pattern: ["api", "model-profiles", null],
  summary: "Get one model profile",
  tags: ["Models"],
  params: z.object({ name: z.string() }),
  responses: {
    200: { description: "The model profile", schema: ModelProfileSchema },
    404: { description: "No profile with that name" },
  },
});

const createProfile = route({
  method: "post",
  path: "/api/model-profiles",
  pattern: ["api", "model-profiles"],
  summary: "Create a model profile",
  description:
    "A profile runs on one harness. `model` must run on that harness and be in the model catalog unless `allowCustomModel` is true (a gateway id, a fresh launch); a `latest:` alias is accepted and resolves at claim. `effort` must be a level the harness and model support. `credentials` pins which pooled keys the profile uses: per credential var of the harness, the last 5 characters of each allowed key (`CODEX_OAUTH` is not supported). Operator only (the shared API key).",
  tags: ["Models"],
  rbac: { permission: "models.profiles.write" },
  body: z.object({
    name: ModelProfileNameSchema,
    harness: ProviderNameSchema,
    model: z.string().trim().min(1),
    effort: ReasoningEffortSchema.nullable().optional(),
    allowCustomModel: z.boolean().optional().default(false),
    description: z.string().trim().max(500).nullable().optional(),
    credentials: ModelProfileCredentialsSchema.nullable().optional(),
  }),
  responses: {
    201: { description: "Profile created", schema: ModelProfileSchema },
    400: { description: "Validation error" },
    403: { description: "Forbidden" },
    409: { description: "A profile with that name exists" },
  },
});

const updateProfile = route({
  method: "patch",
  path: "/api/model-profiles/{name}",
  pattern: ["api", "model-profiles", null],
  summary: "Update a model profile",
  description:
    "Changes the model, effort, custom-model flag, description or credential allowlist; the name and harness are fixed. Omit a field to keep it; `effort: null` and `credentials: null` clear it. Applies to tasks claimed after the change. Operator only (the shared API key).",
  tags: ["Models"],
  rbac: { permission: "models.profiles.write" },
  params: z.object({ name: z.string() }),
  body: z.object({
    model: z.string().trim().min(1).optional(),
    effort: ReasoningEffortSchema.nullable().optional(),
    allowCustomModel: z.boolean().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    credentials: ModelProfileCredentialsSchema.nullable().optional(),
  }),
  responses: {
    200: { description: "Profile updated", schema: ModelProfileSchema },
    400: { description: "Validation error" },
    403: { description: "Forbidden" },
    404: { description: "No profile with that name" },
  },
});

const deleteProfile = route({
  method: "delete",
  path: "/api/model-profiles/{name}",
  pattern: ["api", "model-profiles", null],
  summary: "Delete a model profile",
  description:
    "Refused (409) for a shipped `<harness>-<tier>` seed (edit it instead; it would come back at the next boot), and while an agent has the profile as its default, a schedule names it, or a task holds it (unfinished, or superseded and still owed its resume). Operator only (the shared API key).",
  tags: ["Models"],
  rbac: { permission: "models.profiles.write" },
  params: z.object({ name: z.string() }),
  responses: {
    200: { description: "Profile deleted", schema: z.object({ deleted: z.literal(true) }) },
    403: { description: "Forbidden" },
    404: { description: "No profile with that name" },
    409: { description: "The profile is a seed or still in use" },
  },
});

/**
 * Why a credential allowlist does not fit the profile, or null. Each var must
 * be a credential var the harness loads for this model (harnesses that pick
 * the key by model prefix load a subset).
 */
function credentialsError(
  harness: ProviderName,
  model: string,
  credentials: ModelProfileCredentials | null | undefined,
): string | null {
  if (!credentials) return null;
  // Only the vars the worker loads for this model (`selectCredentials`): an
  // entry for any other var picks nothing, yet the profile check would still
  // judge the agent's pool on it.
  const base = PROVIDER_CREDENTIAL_VARS[harness] ?? [];
  const allowed = new Set(base.length > 0 ? getModelAwareCredentialVars(harness, model) : []);
  for (const [envVar, suffixes] of Object.entries(credentials)) {
    if (envVar === "CODEX_OAUTH") {
      return "A credential allowlist for CODEX_OAUTH is not supported in v1.";
    }
    if (!allowed.has(envVar)) {
      return `"${envVar}" is not a credential var of the ${harness} harness${
        allowed.size > 0 ? ` (expected one of ${[...allowed].join(", ")})` : ""
      }.`;
    }
    if (suffixes.length === 0) return `The allowlist for ${envVar} is empty.`;
  }
  return null;
}

/** Each var's suffixes once, in first-seen order. */
function dedupeCredentials(
  credentials: ModelProfileCredentials | null | undefined,
): ModelProfileCredentials | null | undefined {
  if (!credentials) return credentials;
  return Object.fromEntries(
    Object.entries(credentials).map(([envVar, suffixes]) => [envVar, [...new Set(suffixes)]]),
  );
}

/** Why `harness` + `model` + `effort` + `credentials` is not a valid profile, or null. */
async function profileValueError(input: {
  harness: ProviderName;
  model: string;
  effort: ReasoningEffort | null | undefined;
  allowCustomModel: boolean;
  credentials?: ModelProfileCredentials | null;
}): Promise<string | null> {
  const modelError = await explicitModelError({
    model: input.model,
    allowCustomModel: input.allowCustomModel,
    harnessProvider: input.harness,
  });
  if (modelError) return modelError;
  // The levels the harness and model accept (as PATCH /runtime checks them); a
  // supported level may still be a transport no-op, like Opencode `off`. An
  // alias is judged once it resolves.
  if (
    input.effort &&
    !isAlias(input.model) &&
    !supportedReasoningLevels(input.harness, input.model).includes(input.effort)
  ) {
    return `Effort "${input.effort}" is not supported by ${input.model} on ${input.harness}.`;
  }
  return credentialsError(input.harness, input.model, input.credentials);
}

/** Gate a write on `models.profiles.write`; writes a 403 and returns false on denial. */
async function canWriteProfiles(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
): Promise<boolean> {
  const decision = can({
    principal: await agentFirstPrincipal(req, myAgentId),
    verb: "models.profiles.write",
    resource: { kind: "none" },
    source: "http",
  });
  if (!decision.allow) {
    jsonError(res, "Writing model profiles requires the operator", 403);
    return false;
  }
  return true;
}

export async function handleModelProfiles(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (listProfiles.match(req.method, pathSegments)) {
    const parsed = await listProfiles.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    listProfiles.respond(res, 200, {
      profiles: await listModelProfiles({ harness: parsed.query.harness }),
    });
    return true;
  }

  if (getProfile.match(req.method, pathSegments)) {
    const parsed = await getProfile.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const profile = await getModelProfileByName(parsed.params.name);
    if (!profile) {
      jsonError(res, "Model profile not found", 404);
      return true;
    }
    getProfile.respond(res, 200, profile);
    return true;
  }

  if (createProfile.match(req.method, pathSegments)) {
    const parsed = await createProfile.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await canWriteProfiles(req, res, myAgentId))) return true;
    const body = { ...parsed.body, credentials: dedupeCredentials(parsed.body.credentials) };
    const error = await profileValueError({ ...body, effort: body.effort ?? null });
    if (error) {
      jsonError(res, error, 400);
      return true;
    }
    const created = await createModelProfile(body, {
      userId: await resolveHttpAuditUserId(req, myAgentId),
    });
    if (!created) {
      jsonError(res, `Model profile "${body.name}" already exists`, 409);
      return true;
    }
    createProfile.respond(res, 201, created);
    return true;
  }

  if (updateProfile.match(req.method, pathSegments)) {
    const parsed = await updateProfile.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await canWriteProfiles(req, res, myAgentId))) return true;
    const current = await getModelProfileByName(parsed.params.name);
    if (!current) {
      jsonError(res, "Model profile not found", 404);
      return true;
    }
    const body = { ...parsed.body, credentials: dedupeCredentials(parsed.body.credentials) };
    const error = await profileValueError({
      harness: current.harness,
      model: body.model ?? current.model,
      effort: body.effort === undefined ? current.effort : body.effort,
      allowCustomModel: body.allowCustomModel ?? current.allowCustomModel,
      credentials: body.credentials === undefined ? current.credentials : body.credentials,
    });
    if (error) {
      jsonError(res, error, 400);
      return true;
    }
    const updated = await updateModelProfile(current.name, body, {
      userId: await resolveHttpAuditUserId(req, myAgentId),
    });
    if (!updated) {
      jsonError(res, "Model profile not found", 404);
      return true;
    }
    updateProfile.respond(res, 200, updated);
    return true;
  }

  if (deleteProfile.match(req.method, pathSegments)) {
    const parsed = await deleteProfile.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await canWriteProfiles(req, res, myAgentId))) return true;
    const current = await getModelProfileByName(parsed.params.name);
    if (!current) {
      jsonError(res, "Model profile not found", 404);
      return true;
    }
    if (current.seededFrom?.startsWith("tier:")) {
      jsonError(
        res,
        `"${current.name}" is a shipped tier profile and comes back at the next boot; edit it instead.`,
        409,
      );
      return true;
    }
    const refs = await modelProfileReferences(current.name);
    if (refs.agentIds.length > 0 || refs.openTaskCount > 0 || refs.scheduleIds.length > 0) {
      const schedules = refs.scheduleIds.length > 0 ? ` (${refs.scheduleIds.join(", ")})` : "";
      jsonError(
        res,
        `"${current.name}" is in use: default of ${refs.agentIds.length} agent(s), held by ${refs.openTaskCount} unfinished or awaiting-resume task(s), named by ${refs.scheduleIds.length} schedule(s)${schedules}.`,
        409,
      );
      return true;
    }
    // The count above is for the message; the delete re-checks in the same
    // statement (migration 220 trigger), so a reference written since is a 409.
    const outcome = await deleteModelProfile(current.name);
    if (outcome === "in-use") {
      jsonError(
        res,
        `"${current.name}" is in use by a task, a schedule or an agent default created just now.`,
        409,
      );
      return true;
    }
    if (outcome === "missing") {
      jsonError(res, "Model profile not found", 404);
      return true;
    }
    deleteProfile.respond(res, 200, { deleted: true });
    return true;
  }

  return false;
}
