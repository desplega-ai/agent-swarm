import type { IncomingMessage, ServerResponse } from "node:http";
import { getServicesByAgentId } from "../be/db";

export async function handleEcosystem(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (req.method === "GET" && req.url === "/ecosystem") {
    if (!myAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing X-Agent-ID header" }));
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

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ecosystem));
    return true;

  }


  return false;
}
