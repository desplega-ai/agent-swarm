import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { BROWSER_SDK_JS } from "./browser-sdk";
import { getAvailablePort } from "./port";
import { createTunnel } from "./tunnel";

export interface ArtifactServerOptions {
  name: string;
  static?: string;
  app?: Hono;
  port?: number;
  auth?: boolean;
  subdomain?: string;
}

export interface ArtifactServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  url: string;
  port: number;
  tunnel: ReturnType<typeof createTunnel> extends Promise<infer T> ? T | null : never;
}

export function createArtifactServer(opts: ArtifactServerOptions): ArtifactServer {
  const agentId = process.env.AGENT_ID || "unknown";
  const apiKey = process.env.API_KEY || "";
  const mcpBaseUrl = process.env.MCP_BASE_URL || "http://localhost:3013";

  const app = new Hono();

  // Inject swarm middleware
  app.get("/@swarm/sdk.js", (c) => {
    c.header("Content-Type", "application/javascript");
    return c.body(BROWSER_SDK_JS);
  });

  app.get("/@swarm/config", (c) => {
    return c.json({ agentId, artifactName: opts.name });
  });

  // API proxy — forwards /@swarm/api/* to MCP server
  app.all("/@swarm/api/*", async (c) => {
    const path = c.req.path.replace("/@swarm/api", "/api");
    const targetUrl = `${mcpBaseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "X-Agent-ID": agentId,
    };
    if (c.req.method !== "GET") {
      headers["Content-Type"] = "application/json";
    }
    try {
      const res = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        body: c.req.method !== "GET" ? await c.req.text() : undefined,
      });
      return new Response(res.body, {
        status: res.status,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    } catch (e) {
      return c.json({ error: "Proxy error", message: String(e) }, 502);
    }
  });

  // CORS preflight
  app.options("/@swarm/api/*", (_c) => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  });

  // User app or static serving
  if (opts.app) {
    app.route("/", opts.app);
  } else if (opts.static) {
    app.use("/*", serveStatic({ root: opts.static }));
  }

  let server: ReturnType<typeof Bun.serve> | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: localtunnel tunnel type
  let tunnel: any = null;
  let actualPort = 0;

  const artifact: ArtifactServer = {
    url: "",
    port: 0,
    tunnel: null,

    async start() {
      actualPort = opts.port || (await getAvailablePort());
      server = Bun.serve({ port: actualPort, fetch: app.fetch });
      artifact.port = actualPort;

      const subdomain = opts.subdomain || `${agentId}-${opts.name}`;
      const authPassword = opts.auth === false ? undefined : apiKey;

      tunnel = await createTunnel({
        port: actualPort,
        subdomain,
        auth: authPassword,
      });

      artifact.url = tunnel.url;
      artifact.tunnel = tunnel;

      // Register in service registry
      try {
        await fetch(`${mcpBaseUrl}/api/services`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "X-Agent-ID": agentId,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            script: `artifact-${opts.name}`,
            metadata: {
              type: "artifact",
              artifactName: opts.name,
              port: actualPort,
              publicUrl: tunnel.url,
            },
          }),
        });
      } catch (e) {
        console.warn("Failed to register artifact in service registry:", e);
      }

      console.log(`Artifact "${opts.name}" live at ${tunnel.url} (port ${actualPort})`);
    },

    async stop() {
      if (tunnel) {
        tunnel.close();
        tunnel = null;
      }
      if (server) {
        server.stop();
        server = null;
      }
    },
  };

  return artifact;
}
