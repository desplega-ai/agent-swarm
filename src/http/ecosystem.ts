import type { IncomingMessage, ServerResponse } from "node:http";
import { getServicesByAgentId } from "../be/db";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const getEcosystem = route({
  method: "get",
  path: "/ecosystem",
  pattern: ["ecosystem"],
  summary: "Get PM2 ecosystem config for agent services",
  tags: ["Ecosystem"],
  auth: { apiKey: true, agentId: true },
  responses: {
    200: { description: "PM2 ecosystem config" },
    400: { description: "Missing X-Agent-ID" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleEcosystem(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  myAgentId: string | undefined,
): Promise<boolean> {
  if (getEcosystem.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }

    const services = getServicesByAgentId(myAgentId);

    // Generate PM2 ecosystem format
    const ecosystem = {
      apps: services
        .filter((s) => s.script) // Only include services with script path
        .map((s) => {
          const app: Record<string, unknown> = {
            name: s.name,
            script: s.script,
          };

          if (s.cwd) app.cwd = s.cwd;
          if (s.interpreter) app.interpreter = s.interpreter;
          if (s.args && s.args.length > 0) app.args = s.args;
          if (s.env && Object.keys(s.env).length > 0) app.env = s.env;
          if (s.port)
            app.env = { ...((app.env as Record<string, string>) || {}), PORT: String(s.port) };

          return app;
        }),
    };

    json(res, ecosystem);
    return true;
  }

  return false;
}
