import type { IncomingMessage, ServerResponse } from "node:http";
import {
  deleteSwarmConfig,
  getResolvedConfig,
  getSwarmConfigById,
  getSwarmConfigs,
  maskSecrets,
  upsertSwarmConfig,
} from "../be/db";
import { matchRoute } from "./utils";

export async function handleConfig(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (matchRoute(req.method, pathSegments, "GET", ["api", "config", "resolved"], true)) {
    const agentId = queryParams.get("agentId") || undefined;
    const repoId = queryParams.get("repoId") || undefined;
    const includeSecrets = queryParams.get("includeSecrets") === "true";
    const configs = getResolvedConfig(agentId, repoId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ configs: includeSecrets ? configs : maskSecrets(configs) }));
    return true;
  }

  // GET /api/config/:id - Get single config entry
  if (matchRoute(req.method, pathSegments, "GET", ["api", "config", null], true)) {
    const configId = pathSegments[2]!;
    const includeSecrets = queryParams.get("includeSecrets") === "true";
    const config = getSwarmConfigById(configId);

    if (!config) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Config not found" }));
      return true;
    }

    const result = includeSecrets ? config : maskSecrets([config])[0];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  }

  // GET /api/config - List config entries with optional filters
  if (matchRoute(req.method, pathSegments, "GET", ["api", "config"], true)) {
    const scope = queryParams.get("scope") || undefined;
    const scopeId = queryParams.get("scopeId") || undefined;
    const includeSecrets = queryParams.get("includeSecrets") === "true";
    const configs = getSwarmConfigs({ scope, scopeId });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ configs: includeSecrets ? configs : maskSecrets(configs) }));
    return true;
  }

  // PUT /api/config - Upsert a config entry
  if (matchRoute(req.method, pathSegments, "PUT", ["api", "config"], true)) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!body.scope || !body.key || body.value === undefined) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: scope, key, value" }));
      return true;
    }

    const validScopes = ["global", "agent", "repo"];
    if (!validScopes.includes(body.scope)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid scope. Must be: global, agent, repo" }));
      return true;
    }

    if (body.scope === "global" && body.scopeId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Global scope must not have scopeId" }));
      return true;
    }

    if ((body.scope === "agent" || body.scope === "repo") && !body.scopeId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Agent/repo scope requires scopeId" }));
      return true;
    }

    try {
      const includeSecrets = queryParams.get("includeSecrets") === "true";
      const config = upsertSwarmConfig({
        scope: body.scope,
        scopeId: body.scopeId || null,
        key: body.key,
        value: String(body.value),
        isSecret: body.isSecret || false,
        envPath: body.envPath || null,
        description: body.description || null,
      });
      const result = includeSecrets || !config.isSecret ? config : maskSecrets([config])[0];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (_error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to upsert config" }));
    }
    return true;
  }

  // DELETE /api/config/:id - Delete a config entry
  if (matchRoute(req.method, pathSegments, "DELETE", ["api", "config", null], true)) {
    const configId = pathSegments[2]!;
    const deleted = deleteSwarmConfig(configId);

    if (!deleted) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Config not found" }));
      return true;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return true;
  }

  return false;
}
