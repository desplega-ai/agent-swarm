import { Hono } from "hono";
import { createArtifactServer } from "../artifact-sdk";

interface ArtifactArgs {
  additionalArgs: string[];
  port?: string;
  key?: string;
}

export async function runArtifact(subcommand: string, args: ArtifactArgs) {
  switch (subcommand) {
    case "serve":
      return artifactServe(args);
    case "list":
      return artifactList();
    case "stop":
      return artifactStop(args);
    default:
      printHelp();
  }
}

function printHelp() {
  console.log(`Usage: agent-swarm artifact <subcommand>

Subcommands:
  serve <path> --name <name> [--port <port>] [--no-auth] [--subdomain <sub>]
    Serve a directory or script as an artifact via localtunnel

  list
    List active artifacts (from service registry)

  stop <name>
    Stop an artifact and close its tunnel

Examples:
  agent-swarm artifact serve ./my-report --name my-report
  agent-swarm artifact serve ./server.ts --name dashboard
  agent-swarm artifact list
  agent-swarm artifact stop my-report`);
}

async function artifactServe(args: ArtifactArgs) {
  const additionalArgs = args.additionalArgs || [];

  // Parse artifact-specific args from additionalArgs
  let path = "";
  let name = "";
  let port: number | undefined;
  let noAuth = false;
  let subdomain: string | undefined;

  for (let i = 0; i < additionalArgs.length; i++) {
    const arg = additionalArgs[i] ?? "";
    if (arg === "--name") {
      name = additionalArgs[i + 1] ?? "";
      i++;
    } else if (arg === "--port") {
      port = Number.parseInt(additionalArgs[i + 1] ?? "0", 10);
      i++;
    } else if (arg === "--no-auth") {
      noAuth = true;
    } else if (arg === "--subdomain") {
      subdomain = additionalArgs[i + 1] ?? "";
      i++;
    } else if (!arg.startsWith("-") && !path) {
      path = arg;
    }
  }

  if (!path) {
    console.error("Error: path is required. Usage: artifact serve <path> --name <name>");
    process.exit(1);
  }

  if (!name) {
    // Derive name from path
    name = path.split("/").filter(Boolean).pop() || "artifact";
  }

  // Determine if path is a directory or a script
  const file = Bun.file(path);
  const isFile = await file.exists();

  let app: Hono | undefined;
  let staticDir: string | undefined;

  if (isFile && (path.endsWith(".ts") || path.endsWith(".js"))) {
    // Script mode — import the module and use its default export as a Hono app
    try {
      const mod = await import(path.startsWith("/") ? path : `${process.cwd()}/${path}`);
      if (mod.default instanceof Hono) {
        app = mod.default;
      } else {
        console.error(`Error: ${path} must export a default Hono app instance`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`Error loading ${path}:`, e);
      process.exit(1);
    }
  } else {
    // Static directory mode
    const { existsSync } = await import("node:fs");
    if (!existsSync(path)) {
      console.error(`Error: path "${path}" does not exist`);
      process.exit(1);
    }
    staticDir = path;
  }

  const server = createArtifactServer({
    name,
    app,
    static: staticDir,
    port,
    auth: noAuth ? false : undefined,
    subdomain,
  });

  await server.start();

  // Keep the process alive
  process.on("SIGINT", async () => {
    console.log(`\nStopping artifact "${name}"...`);
    await server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.stop();
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

async function artifactList() {
  const apiKey = process.env.API_KEY || "";
  const mcpBaseUrl = process.env.MCP_BASE_URL || "http://localhost:3013";
  const agentId = process.env.AGENT_ID || "";

  try {
    const res = await fetch(`${mcpBaseUrl}/api/services`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Agent-ID": agentId,
      },
    });

    if (!res.ok) {
      console.error(`Failed to fetch services: ${res.status} ${res.statusText}`);
      process.exit(1);
    }

    const services = (await res.json()) as Array<{
      name: string;
      agentId: string;
      status: string;
      metadata?: { type?: string; artifactName?: string; port?: number; publicUrl?: string };
    }>;

    const artifacts = services.filter((s) => s.metadata?.type === "artifact");

    if (artifacts.length === 0) {
      console.log("No active artifacts");
      return;
    }

    // Format as table
    console.log(
      `${"NAME".padEnd(20)} ${"AGENT".padEnd(16)} ${"PORT".padEnd(8)} ${"URL".padEnd(50)} STATUS`,
    );
    for (const a of artifacts) {
      const name = (a.metadata?.artifactName || a.name).padEnd(20);
      const agent = (a.agentId || "").substring(0, 14).padEnd(16);
      const port = String(a.metadata?.port || "?").padEnd(8);
      const url = (a.metadata?.publicUrl || "").padEnd(50);
      console.log(`${name} ${agent} ${port} ${url} ${a.status}`);
    }
  } catch (e) {
    console.error("Failed to list artifacts:", e);
    process.exit(1);
  }
}

async function artifactStop(args: ArtifactArgs) {
  const name = args.additionalArgs?.[0];
  if (!name) {
    console.error("Error: name is required. Usage: artifact stop <name>");
    process.exit(1);
  }

  const apiKey = process.env.API_KEY || "";
  const mcpBaseUrl = process.env.MCP_BASE_URL || "http://localhost:3013";
  const agentId = process.env.AGENT_ID || "";

  // 1. Try to stop PM2 process
  try {
    await Bun.$`pm2 delete artifact-${name} 2>/dev/null`.quiet();
    console.log(`Stopped PM2 process: artifact-${name}`);
  } catch {
    // Process might not exist in PM2
  }

  // 2. Unregister from service registry
  try {
    const res = await fetch(`${mcpBaseUrl}/api/services`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Agent-ID": agentId,
      },
    });

    if (res.ok) {
      const services = (await res.json()) as Array<{
        id: string;
        name: string;
        metadata?: { type?: string; artifactName?: string };
      }>;
      const service = services.find(
        (s) => s.metadata?.type === "artifact" && s.metadata?.artifactName === name,
      );

      if (service) {
        await fetch(`${mcpBaseUrl}/api/services/${service.id}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "X-Agent-ID": agentId,
          },
        });
      }
    }
  } catch {
    // Non-fatal
  }

  console.log(`Artifact '${name}' stopped.`);
}
