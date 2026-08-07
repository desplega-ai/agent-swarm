import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getServicesByAgentId } from "../be/db";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const EcosystemAppSchema = z.object({
  name: z.string(),
  script: z.string(),
  cwd: z.string().optional(),
  interpreter: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

type EcosystemApp = z.infer<typeof EcosystemAppSchema>;

const getEcosystem = route({
  method: "get",
  path: "/ecosystem",
  pattern: ["ecosystem"],
  summary: "Get PM2 ecosystem config for agent services",
  tags: ["Ecosystem"],
  auth: { apiKey: true, agentId: true },
  responses: {
    200: {
      description: "PM2 ecosystem config",
      schema: z.object({ apps: z.array(EcosystemAppSchema) }),
    },
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
          const app: EcosystemApp = {
            name: s.name,
            script: s.script,
          };

          if (s.cwd) app.cwd = s.cwd;
          if (s.interpreter) app.interpreter = s.interpreter;
          if (s.args && s.args.length > 0) app.args = s.args;
          if (s.env && Object.keys(s.env).length > 0) app.env = s.env;
          if (s.port) app.env = { ...(app.env || {}), PORT: String(s.port) };

          return app;
        }),
    };

    getEcosystem.respond(res, 200, ecosystem);
    return true;
  }

  return false;
}
