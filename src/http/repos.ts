import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  createSwarmRepo,
  deleteSwarmRepo,
  getSwarmRepoById,
  getSwarmRepos,
  updateSwarmRepo,
} from "../be/db";
import { RepoGuidelinesSchema, SwarmRepoSchema } from "../types";
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
    guidelines: RepoGuidelinesSchema.nullable().optional(),
  }),
  responses: {
    201: { description: "Repo created", schema: SwarmRepoSchema },
    400: { description: "Validation error", schema: z.object({ error: z.string() }) },
    409: { description: "Duplicate repo", schema: z.object({ error: z.string() }) },
  },
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
    guidelines: RepoGuidelinesSchema.nullable().optional(),
  }),
  responses: {
    200: { description: "Repo updated", schema: SwarmRepoSchema },
    404: { description: "Repo not found", schema: z.object({ error: z.string() }) },
    409: { description: "Duplicate repo", schema: z.object({ error: z.string() }) },
  },
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

export async function handleRepos(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (getRepo.match(req.method, pathSegments)) {
    const parsed = await getRepo.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const repo = getSwarmRepoById(parsed.params.id);
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
    const repos = getSwarmRepos(Object.keys(filters).length > 0 ? filters : undefined);
    json(res, { repos });
    return true;
  }

  if (createRepo.match(req.method, pathSegments)) {
    const parsed = await createRepo.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    try {
      const repo = createSwarmRepo({
        url: parsed.body.url,
        name: parsed.body.name,
        clonePath: parsed.body.clonePath,
        defaultBranch: parsed.body.defaultBranch,
        autoClone: parsed.body.autoClone,
        guidelines: parsed.body.guidelines,
      });
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
    try {
      const updated = updateSwarmRepo(parsed.params.id, {
        url: parsed.body.url,
        name: parsed.body.name,
        clonePath: parsed.body.clonePath,
        defaultBranch: parsed.body.defaultBranch,
        autoClone: parsed.body.autoClone,
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
    const deleted = deleteSwarmRepo(parsed.params.id);
    if (!deleted) {
      jsonError(res, "Repo not found", 404);
      return true;
    }
    json(res, { success: true });
    return true;
  }

  return false;
}
