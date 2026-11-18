/** Worker boot step; deliberately standalone so both worker images can run it before setup. */
export interface McpConfigDependencies {
  env: Record<string, string | undefined>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Absent file reads as null; any other failure rejects. */
  readTextFile: (path: string) => Promise<string | null>;
  writeTextFile: (path: string, content: string) => Promise<void>;
  log: (message: string) => void;
}

const defaults: McpConfigDependencies = {
  env: process.env,
  fetch: (url, init) => fetch(url, init),
  readTextFile: async (path) => {
    const file = Bun.file(path);
    return (await file.exists()) ? file.text() : null;
  },
  writeTextFile: async (path, content) => {
    await Bun.write(path, content);
  },
  log: (message) => console.log(message),
};

export interface McpConfigInputs {
  /** Swarm API key, piped on stdin by the shell shim so it never reaches argv. */
  apiKey: string;
  /** Resolved control-plane base URL; the entrypoint keeps it shell-local, so it is an argument. */
  mcpUrl: string;
  homeDir: string;
  workspaceDir: string;
}

interface AgentSwarmServer {
  type: "http";
  url: string;
  headers: Record<string, string>;
}

interface AgentmailServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface McpConfigFile {
  mcpServers: { "agent-swarm": AgentSwarmServer; agentmail?: AgentmailServer };
}

/** The old `jq -n` base object: swarm HTTP server, optional X-Agent-ID, optional agentmail. */
function buildMcpConfig(options: {
  mcpUrl: string;
  apiKey: string;
  agentId?: string;
  agentmailApiKey?: string;
}): McpConfigFile {
  const headers: Record<string, string> = { Authorization: `Bearer ${options.apiKey}` };
  if (options.agentId) headers["X-Agent-ID"] = options.agentId;
  const config: McpConfigFile = {
    mcpServers: {
      "agent-swarm": { type: "http", url: `${options.mcpUrl}/mcp`, headers },
    },
  };
  if (options.agentmailApiKey) {
    config.mcpServers.agentmail = {
      command: "npx",
      args: ["-y", "agentmail-mcp"],
      env: { AGENTMAIL_API_KEY: options.agentmailApiKey },
    };
  }
  return config;
}

/** Match the old `jq .servers | length` count: arrays and objects only; anything else fails. */
function installedServerNames(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const servers = (payload as { servers?: unknown }).servers;
  if (servers === null || servers === undefined) return [];
  if (typeof servers === "string" || typeof servers === "number") {
    throw new Error("MCP servers payload is not iterable");
  }
  const entries = Array.isArray(servers) ? servers : Object.values(servers);
  return entries.map(serverName);
}

function serverName(entry: unknown): string {
  if (typeof entry !== "object" || entry === null) {
    throw new Error("MCP server entry is not a JSON object");
  }
  const name = (entry as { name?: unknown }).name;
  // `"mcp__" + null` is `"mcp__"` in jq, so a missing name still yields a pattern.
  if (name === null || name === undefined) return "";
  if (typeof name !== "string") throw new Error("MCP server name is not a string");
  return name;
}

/** The old `jq --slurpfile` merge: append `mcp__<name>__*` patterns, sort and dedupe. */
function mergePermissionPatterns(
  settings: unknown,
  serverNames: string[],
): Record<string, unknown> {
  if (typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("settings.json is not a JSON object");
  }
  // jq assigns into `null` by creating the object, so a literal null file still
  // ends up with a permissions object.
  const root = (settings ?? {}) as Record<string, unknown>;
  const permissions = root.permissions;
  if (
    permissions !== null &&
    permissions !== undefined &&
    (typeof permissions !== "object" || Array.isArray(permissions))
  ) {
    throw new Error("settings.json permissions is not a JSON object");
  }
  const permissionObject = (permissions ?? {}) as Record<string, unknown>;
  const allow = permissionObject.allow;
  if (allow !== null && allow !== undefined && !Array.isArray(allow)) {
    throw new Error("settings.json permissions.allow is not an array");
  }
  const patterns = new Set<unknown>(allow ?? []);
  for (const name of serverNames) patterns.add(`mcp__${name}__*`);
  const merged = [...patterns];
  // jq `unique` sorts. Settings entries are strings, so the default sort matches.
  merged.sort();
  return { ...root, permissions: { ...permissionObject, allow: merged } };
}

async function fetchInstalledServers(
  mcpUrl: string,
  agentId: string,
  apiKey: string,
  probe: McpConfigDependencies["fetch"],
): Promise<unknown> {
  try {
    // resolveSecrets=false: the entrypoint only needs names; the per-session
    // dispatcher re-fetches the servers with fresh credentials (issue #369).
    const response = await probe(
      `${mcpUrl}/api/agents/${agentId}/mcp-servers?resolveSecrets=false`,
      { headers: { Authorization: `Bearer ${apiKey}` }, redirect: "manual" },
    );
    // Match `curl -sf`: HTTP errors and empty bodies leave nothing to parse.
    if (!response.ok) return null;
    const body = await response.text();
    return body === "" ? null : JSON.parse(body);
  } catch {
    // Best-effort, like the old `|| true`: the file writes still run.
    return null;
  }
}

/**
 * Write `/workspace/.mcp.json` and register the installed MCP servers' permission
 * patterns in `~/.claude/settings.json`. Resolved credentials are never baked
 * into the project config: the provider dispatcher injects them per session.
 */
export async function configureMcpConfig(
  inputs: McpConfigInputs,
  dependencies: Partial<McpConfigDependencies> = {},
): Promise<boolean> {
  const {
    env,
    fetch: probe,
    readTextFile,
    writeTextFile,
    log,
  } = {
    ...defaults,
    ...dependencies,
  };
  try {
    // Managed agents read MCP servers from the Anthropic agent definition instead.
    if (env.HARNESS_PROVIDER === "claude-managed") {
      log("Skipping local .mcp.json (claude-managed reads MCP from agent definition)");
      return true;
    }

    log(`Creating MCP config in ${inputs.workspaceDir}...`);
    const mcpUrl = inputs.mcpUrl;
    const agentId = env.AGENT_ID;
    const config = buildMcpConfig({
      mcpUrl,
      apiKey: inputs.apiKey,
      agentId,
      agentmailApiKey: env.AGENTMAIL_API_KEY,
    });

    let serverNames: string[] = [];
    if (agentId && inputs.apiKey) {
      log("Fetching installed MCP server names (for permission patterns only)...");
      const payload = await fetchInstalledServers(mcpUrl, agentId, inputs.apiKey, probe);
      serverNames = installedServerNames(payload);
      if (serverNames.length > 0) {
        log(
          `Found ${serverNames.length} installed MCP server(s) — will be injected per-session, not baked into .mcp.json`,
        );
      }
    }

    await writeTextFile(`${inputs.workspaceDir}/.mcp.json`, `${JSON.stringify(config, null, 2)}\n`);

    if (serverNames.length > 0) {
      const settingsPath = `${inputs.homeDir}/.claude/settings.json`;
      const current = await readTextFile(settingsPath);
      if (current !== null) {
        log("Adding MCP server permission patterns to settings.json");
        // jq --slurpfile reads a blank file as an empty array, so `$settings[0]`
        // is null and the merge repairs the file instead of failing.
        const settings = current.trim() === "" ? null : (JSON.parse(current) as unknown);
        const updated = mergePermissionPatterns(settings, serverNames);
        await writeTextFile(settingsPath, `${JSON.stringify(updated, null, 2)}\n`);
      }
    }
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`[entrypoint] FATAL: MCP config step failed: ${reason}; exiting.`);
    return false;
  }
}

if (import.meta.main) {
  const apiKey = (await Bun.stdin.text()).replace(/\r?\n$/, "");
  process.exitCode = (await configureMcpConfig({
    apiKey,
    mcpUrl: Bun.argv[4] ?? "",
    homeDir: Bun.argv[2] ?? process.env.HOME ?? "/home/worker",
    workspaceDir: Bun.argv[3] ?? "/workspace",
  }))
    ? 0
    : 1;
}
