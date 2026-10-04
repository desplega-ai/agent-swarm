import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createSwarmRepo,
  deleteSwarmRepo,
  getSwarmRepoById,
  getSwarmRepos,
  updateSwarmRepo,
} from "../be/db";
import { changesAllowMerge } from "../be/repo-merge-policy";
import { can } from "../rbac";
import { emitIntegrationConnected } from "../telemetry";
import {
  type RepoGuidelines,
  RepoGuidelinesInputSchema,
  RepoHooksSchema,
  SwarmRepoSchema,
} from "../types";
import { agentFirstPrincipal } from "./request-principal";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const getRepo = route({
  method: "get",
  path: "/api/repos/{id}",
  pattern: ["api", "repos", null],
  summary: "Get a repo by ID",
  tags: ["Repos"],
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: { description: "Repo details", schema: SwarmRepoSchema },
    404: { description: "Repo not found", schema: z.object({ error: z.string() }) },
  },
});

const listRepos = route({
  method: "get",
  path: "/api/repos",
  pattern: ["api", "repos"],
  summary: "List repos with optional filters",
  tags: ["Repos"],
  query: z.object({
    autoClone: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
    name: z.string().optional(),
  }),
  responses: {
    200: { description: "List of repos", schema: z.object({ repos: z.array(SwarmRepoSchema) }) },
  },
});

const createRepo = route({
  method: "post",
  path: "/api/repos",
  pattern: ["api", "repos"],
  summary: "Create a new repo",
  tags: ["Repos"],
  body: z.object({
    url: z.string().min(1),
    name: z.string().min(1),
    clonePath: z.string().optional(),
    defaultBranch: z.string().optional(),
    autoClone: z.boolean().optional(),
    hooks: RepoHooksSchema.optional(),
    guidelines: RepoGuidelinesInputSchema.nullable().optional(),
  }),
  responses: {
    201: { description: "Repo created", schema: SwarmRepoSchema },
    400: { description: "Validation error", schema: z.object({ error: z.string() }) },
    403: {
      description: "Only the lead, the operator or a user can turn allowMerge on",
      schema: z.object({ error: z.string() }),
    },
    409: { description: "Duplicate repo", schema: z.object({ error: z.string() }) },
  },
  rbac: { permission: "repo.merge-policy.write" },
});

const updateRepo = route({
  method: "put",
  path: "/api/repos/{id}",
  pattern: ["api", "repos", null],
  summary: "Update a repo",
  tags: ["Repos"],
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    url: z.string().optional(),
    name: z.string().optional(),
    clonePath: z.string().optional(),
    defaultBranch: z.string().optional(),
    autoClone: z.boolean().optional(),
    hooks: RepoHooksSchema.nullable().optional(),
    guidelines: RepoGuidelinesInputSchema.nullable().optional(),
  }),
  responses: {
    200: { description: "Repo updated", schema: SwarmRepoSchema },
    403: {
      description: "Only the lead, the operator or a user can change allowMerge",
      schema: z.object({ error: z.string() }),
    },
    404: { description: "Repo not found", schema: z.object({ error: z.string() }) },
    409: { description: "Duplicate repo", schema: z.object({ error: z.string() }) },
  },
  rbac: { permission: "repo.merge-policy.write" },
});

const deleteRepo = route({
  method: "delete",
  path: "/api/repos/{id}",
  pattern: ["api", "repos", null],
  summary: "Delete a repo",
  tags: ["Repos"],
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: { description: "Repo deleted", schema: z.object({ success: z.boolean() }) },
    404: { description: "Repo not found", schema: z.object({ error: z.string() }) },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

/** Sends the 403 and returns false when the caller may not make this allowMerge change. */
async function allowMergeChangePermitted(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
  current: RepoGuidelines | null | undefined,
  incoming: RepoGuidelines | null | undefined,
): Promise<boolean> {
  if (!changesAllowMerge(current, incoming)) return true;
  const decision = can({
    principal: await agentFirstPrincipal(req, myAgentId),
    verb: "repo.merge-policy.write",
    resource: { kind: "none" },
    source: "http",
  });
  if (decision.allow) return true;
  jsonError(res, `Forbidden: ${decision.reason}`, 403);
  return false;
}

export async function handleRepos(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (getRepo.match(req.method, pathSegments)) {
    const parsed = await getRepo.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const repo = await getSwarmRepoById(parsed.params.id);
    if (!repo) {
      jsonError(res, "Repo not found", 404);
      return true;
    }
    json(res, repo);
    return true;
  }

  if (listRepos.match(req.method, pathSegments)) {
    const parsed = await listRepos.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const filters: { autoClone?: boolean; name?: string } = {};
    if (parsed.query.autoClone !== undefined) filters.autoClone = parsed.query.autoClone;
    if (parsed.query.name) filters.name = parsed.query.name;
    const repos = await getSwarmRepos(Object.keys(filters).length > 0 ? filters : undefined);
    json(res, { repos });
    return true;
  }

  if (createRepo.match(req.method, pathSegments)) {
    const parsed = await createRepo.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await allowMergeChangePermitted(req, res, myAgentId, null, parsed.body.guidelines))) {
      return true;
    }
    try {
      const repo = await createSwarmRepo({
        url: parsed.body.url,
        name: parsed.body.name,
        clonePath: parsed.body.clonePath,
        defaultBranch: parsed.body.defaultBranch,
        autoClone: parsed.body.autoClone,
        hooks: parsed.body.hooks,
        guidelines: parsed.body.guidelines,
      });
      try {
        emitIntegrationConnected("code_repo", repo.url, (await getSwarmRepos()).length === 1);
      } catch {
        // Telemetry must never break repo creation.
      }
      json(res, repo, 201);
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes("UNIQUE constraint")) {
        jsonError(res, "Repo with that url, name, or clonePath already exists", 409);
      } else {
        jsonError(res, "Failed to create repo", 500);
      }
    }
    return true;
  }

  if (updateRepo.match(req.method, pathSegments)) {
    const parsed = await updateRepo.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (parsed.body.guidelines !== undefined) {
      const existing = await getSwarmRepoById(parsed.params.id);
      if (
        existing &&
        !(await allowMergeChangePermitted(
          req,
          res,
          myAgentId,
          existing.guidelines,
          parsed.body.guidelines,
        ))
      ) {
        return true;
      }
    }
    try {
      const updated = await updateSwarmRepo(parsed.params.id, {
        url: parsed.body.url,
        name: parsed.body.name,
        clonePath: parsed.body.clonePath,
        defaultBranch: parsed.body.defaultBranch,
        autoClone: parsed.body.autoClone,
        hooks: parsed.body.hooks,
        guidelines: parsed.body.guidelines,
      });
      if (!updated) {
        jsonError(res, "Repo not found", 404);
        return true;
      }
      json(res, updated);
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes("UNIQUE constraint")) {
        jsonError(res, "Repo with that url, name, or clonePath already exists", 409);
      } else {
        jsonError(res, "Failed to update repo", 500);
      }
    }
    return true;
  }

  if (deleteRepo.match(req.method, pathSegments)) {
    const parsed = await deleteRepo.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const deleted = await deleteSwarmRepo(parsed.params.id);
    if (!deleted) {
      jsonError(res, "Repo not found", 404);
      return true;
    }
    json(res, { success: true });
    return true;
  }

  return false;
}
