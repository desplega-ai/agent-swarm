import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createSwarmRepo,
  deleteSwarmRepo,
  getSwarmRepoById,
  getSwarmRepos,
  updateSwarmRepo,
} from "../be/db";
import { matchRoute } from "./utils";

export async function handleRepos(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (matchRoute(req.method, pathSegments, "GET", ["api", "repos", null], true)) {
    const repo = getSwarmRepoById(pathSegments[2]!);
    if (!repo) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Repo not found" }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(repo));
    return true;
  }

  // GET /api/repos - List repos with optional filters
  if (matchRoute(req.method, pathSegments, "GET", ["api", "repos"], true)) {
    const autoCloneParam = queryParams.get("autoClone");
    const nameParam = queryParams.get("name") || undefined;
    const filters: { autoClone?: boolean; name?: string } = {};
    if (autoCloneParam !== null) {
      filters.autoClone = autoCloneParam === "true";
    }
    if (nameParam) {
      filters.name = nameParam;
    }
    const repos = getSwarmRepos(Object.keys(filters).length > 0 ? filters : undefined);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ repos }));
    return true;
  }

  // POST /api/repos - Create a new repo
  if (matchRoute(req.method, pathSegments, "POST", ["api", "repos"], true)) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!body.url || !body.name) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: url, name" }));
      return true;
    }

    try {
      const repo = createSwarmRepo({
        url: body.url,
        name: body.name,
        clonePath: body.clonePath,
        defaultBranch: body.defaultBranch,
        autoClone: body.autoClone,
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(repo));
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes("UNIQUE constraint")) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Repo with that url, name, or clonePath already exists" }));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to create repo" }));
      }
    }
    return true;
  }

  // PUT /api/repos/:id - Update a repo
  if (matchRoute(req.method, pathSegments, "PUT", ["api", "repos", null], true)) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    try {
      const updated = updateSwarmRepo(pathSegments[2]!, {
        url: body.url,
        name: body.name,
        clonePath: body.clonePath,
        defaultBranch: body.defaultBranch,
        autoClone: body.autoClone,
      });

      if (!updated) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Repo not found" }));
        return true;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(updated));
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes("UNIQUE constraint")) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Repo with that url, name, or clonePath already exists" }));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to update repo" }));
      }
    }
    return true;
  }

  // DELETE /api/repos/:id - Delete a repo
  if (matchRoute(req.method, pathSegments, "DELETE", ["api", "repos", null], true)) {
    const deleted = deleteSwarmRepo(pathSegments[2]!);
    if (!deleted) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Repo not found" }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return true;
  }

  // POST /api/memory/index - Ingest content into memory system (async embedding)

  return false;
}
