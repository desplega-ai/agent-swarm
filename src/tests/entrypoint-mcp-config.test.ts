import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureMcpConfig } from "../commands/entrypoint-mcp-config";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

/**
 * Regression tests for the `configure_mcp_config` boot step in
 * docker-entrypoint.sh: the project /workspace/.mcp.json and the installed MCP
 * server permission patterns merged into ~/.claude/settings.json.
 *
 * Injected environment, fetch and file IO cover policy without a container.
 * The deployed shell shim then runs with an isolated copy of the Bun helper
 * against a real HTTP server: the shell call, stdin key handoff, argument
 * handling, exit status and TypeScript logic are the real ones.
 */

const TEST_TIMEOUT = CHILD_PROCESS_TEST_BUDGET_MS;
const entrypointPath = `${import.meta.dir}/../../docker-entrypoint.sh`;
const WORKER_HOME = "/home/worker";
const WORKSPACE = "/workspace";
const SETTINGS_PATH = `${WORKER_HOME}/.claude/settings.json`;

interface MemoryIo {
  files: Map<string, string>;
  readTextFile: (path: string) => Promise<string | null>;
  writeTextFile: (path: string, content: string) => Promise<void>;
}

function memoryIo(initial: Record<string, string> = {}): MemoryIo {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readTextFile: async (path) => files.get(path) ?? null,
    writeTextFile: async (path, content) => {
      files.set(path, content);
    },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runStep(
  env: Record<string, string | undefined>,
  options: {
    apiKey?: string;
    mcpUrl?: string;
    io?: MemoryIo;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
  } = {},
): Promise<{ ok: boolean; logs: string[]; io: MemoryIo }> {
  const io = options.io ?? memoryIo();
  const logs: string[] = [];
  const ok = await configureMcpConfig(
    {
      apiKey: options.apiKey ?? "swarm-key",
      mcpUrl: options.mcpUrl ?? "http://api.test:3013",
      homeDir: WORKER_HOME,
      workspaceDir: WORKSPACE,
    },
    {
      env,
      log: (message) => logs.push(message),
      fetch:
        options.fetch ??
        (() => {
          throw new Error("unexpected fetch");
        }),
      readTextFile: io.readTextFile,
      writeTextFile: io.writeTextFile,
    },
  );
  return { ok, logs, io };
}

const baseEnv = { HARNESS_PROVIDER: "claude" };

describe("configureMcpConfig: project config", () => {
  test("writes the base swarm MCP server for a non-managed provider", async () => {
    const { ok, logs, io } = await runStep(baseEnv);

    expect(ok).toBe(true);
    expect(logs).toEqual(["Creating MCP config in /workspace..."]);
    expect(JSON.parse(io.files.get(`${WORKSPACE}/.mcp.json`)!)).toEqual({
      mcpServers: {
        "agent-swarm": {
          type: "http",
          url: "http://api.test:3013/mcp",
          headers: { Authorization: "Bearer swarm-key" },
        },
      },
    });
  });

  test("skips the file for claude-managed, which reads MCP from the agent definition", async () => {
    const { ok, logs, io } = await runStep({
      ...baseEnv,
      HARNESS_PROVIDER: "claude-managed",
    });

    expect(ok).toBe(true);
    expect(logs).toEqual([
      "Skipping local .mcp.json (claude-managed reads MCP from agent definition)",
    ]);
    expect(io.files.size).toBe(0);
  });

  test("adds the X-Agent-ID header and fetches installed server names", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const { ok, logs, io } = await runStep(
      { ...baseEnv, AGENT_ID: "agent-1" },
      {
        fetch: async (url, init) => {
          requests.push({ url, init });
          return jsonResponse({ servers: [{ name: "github" }, { name: "slack" }] });
        },
      },
    );

    expect(ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "http://api.test:3013/api/agents/agent-1/mcp-servers?resolveSecrets=false",
    );
    expect((requests[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer swarm-key",
    );
    expect(requests[0]!.init.redirect).toBe("manual");
    expect(logs).toContain("Fetching installed MCP server names (for permission patterns only)...");
    expect(logs).toContain(
      "Found 2 installed MCP server(s) — will be injected per-session, not baked into .mcp.json",
    );
    const config = JSON.parse(io.files.get(`${WORKSPACE}/.mcp.json`)!);
    expect(config.mcpServers["agent-swarm"].headers["X-Agent-ID"]).toBe("agent-1");
  });

  test("adds agentmail only when its API key is set", async () => {
    const { ok, io } = await runStep({ ...baseEnv, AGENTMAIL_API_KEY: "mail-key" });

    expect(ok).toBe(true);
    expect(JSON.parse(io.files.get(`${WORKSPACE}/.mcp.json`)!).mcpServers.agentmail).toEqual({
      command: "npx",
      args: ["-y", "agentmail-mcp"],
      env: { AGENTMAIL_API_KEY: "mail-key" },
    });
  });

  test("never fetches server names without an agent id or an API key", async () => {
    const withoutAgent = await runStep(baseEnv);
    expect(withoutAgent.ok).toBe(true);

    const withoutKey = await runStep({ ...baseEnv, AGENT_ID: "agent-1" }, { apiKey: "" });
    expect(withoutKey.ok).toBe(true);
    expect(withoutKey.logs).not.toContain(
      "Fetching installed MCP server names (for permission patterns only)...",
    );
    expect(
      JSON.parse(withoutKey.io.files.get(`${WORKSPACE}/.mcp.json`)!).mcpServers["agent-swarm"]
        .headers,
    ).toEqual({
      Authorization: "Bearer ",
      "X-Agent-ID": "agent-1",
    });
  });

  test.each([
    ["a connection failure", () => Promise.reject(new Error("ECONNREFUSED"))],
    ["an HTTP error", () => Promise.resolve(jsonResponse({ error: "no" }, 500))],
    ["a non-JSON body", () => Promise.resolve(new Response("not json", { status: 200 }))],
  ])("still writes the project config after %s", async (_label, fetch) => {
    const { ok, logs, io } = await runStep(
      { ...baseEnv, AGENT_ID: "agent-1" },
      { fetch: fetch as (url: string, init: RequestInit) => Promise<Response> },
    );

    expect(ok).toBe(true);
    expect(io.files.has(`${WORKSPACE}/.mcp.json`)).toBe(true);
    expect(logs.some((line) => line.includes("Found "))).toBe(false);
    expect(logs.some((line) => line.includes("Adding MCP server permission patterns"))).toBe(false);
  });

  test("does not remove a stale .mcp.json when claude-managed skips the step", async () => {
    const io = memoryIo({ [`${WORKSPACE}/.mcp.json`]: "{}" });
    const { ok } = await runStep({ ...baseEnv, HARNESS_PROVIDER: "claude-managed" }, { io });

    expect(ok).toBe(true);
    expect(io.files.get(`${WORKSPACE}/.mcp.json`)).toBe("{}");
  });
});

describe("configureMcpConfig: settings.json permission patterns", () => {
  function settingsIo(settings: string): MemoryIo {
    return memoryIo({ [SETTINGS_PATH]: settings });
  }

  test("merges, dedupes and sorts mcp__<server>__* patterns", async () => {
    const { ok, logs, io } = await runStep(
      { ...baseEnv, AGENT_ID: "agent-1" },
      {
        io: settingsIo(
          JSON.stringify({ permissions: { allow: ["Bash", "mcp__swarm__*"] }, env: { A: "1" } }),
        ),
        fetch: async () =>
          jsonResponse({ servers: [{ name: "github" }, { name: "slack" }, { name: "swarm" }] }),
      },
    );

    expect(ok).toBe(true);
    expect(logs).toContain("Adding MCP server permission patterns to settings.json");
    expect(JSON.parse(io.files.get(SETTINGS_PATH)!)).toEqual({
      permissions: {
        allow: ["Bash", "mcp__github__*", "mcp__slack__*", "mcp__swarm__*"],
      },
      env: { A: "1" },
    });
  });

  test("creates the permissions object when settings.json has none", async () => {
    const { ok, io } = await runStep(
      { ...baseEnv, AGENT_ID: "agent-1" },
      {
        io: settingsIo(JSON.stringify({ model: "sonnet" })),
        fetch: async () => jsonResponse({ servers: [{ name: "github" }] }),
      },
    );

    expect(ok).toBe(true);
    expect(JSON.parse(io.files.get(SETTINGS_PATH)!)).toEqual({
      model: "sonnet",
      permissions: { allow: ["mcp__github__*"] },
    });
  });

  test("keeps the jq pattern for a server entry with no name", async () => {
    const { ok, io } = await runStep(
      { ...baseEnv, AGENT_ID: "agent-1" },
      {
        io: settingsIo(JSON.stringify({ permissions: { allow: [] } })),
        fetch: async () => jsonResponse({ servers: [{ id: "row-1" }] }),
      },
    );

    expect(ok).toBe(true);
    expect(JSON.parse(io.files.get(SETTINGS_PATH)!).permissions.allow).toEqual(["mcp____*"]);
  });

  test("leaves settings.json alone when the file is missing or no servers are installed", async () => {
    const missing = await runStep(
      { ...baseEnv, AGENT_ID: "agent-1" },
      { fetch: async () => jsonResponse({ servers: [{ name: "github" }] }) },
    );
    expect(missing.ok).toBe(true);
    expect(missing.io.files.has(SETTINGS_PATH)).toBe(false);

    const none = await runStep(
      { ...baseEnv, AGENT_ID: "agent-1" },
      {
        io: settingsIo(JSON.stringify({ permissions: { allow: ["Bash"] } })),
        fetch: async () => jsonResponse({ servers: [] }),
      },
    );
    expect(none.ok).toBe(true);
    expect(none.io.files.has(SETTINGS_PATH)).toBe(true);
    expect(JSON.parse(none.io.files.get(SETTINGS_PATH)!)).toEqual({
      permissions: { allow: ["Bash"] },
    });
  });

  test("treats a literal null settings.json as an empty object, like jq", async () => {
    const { ok, io } = await runStep(
      { ...baseEnv, AGENT_ID: "agent-1" },
      {
        io: settingsIo("null"),
        fetch: async () => jsonResponse({ servers: [{ name: "github" }] }),
      },
    );

    expect(ok).toBe(true);
    expect(JSON.parse(io.files.get(SETTINGS_PATH)!)).toEqual({
      permissions: { allow: ["mcp__github__*"] },
    });
  });

  test("repairs an empty settings.json, like jq --slurpfile", async () => {
    const { ok, io } = await runStep(
      { ...baseEnv, AGENT_ID: "agent-1" },
      {
        io: settingsIo(""),
        fetch: async () => jsonResponse({ servers: [{ name: "github" }] }),
      },
    );

    expect(ok).toBe(true);
    expect(JSON.parse(io.files.get(SETTINGS_PATH)!)).toEqual({
      permissions: { allow: ["mcp__github__*"] },
    });
  });

  test.each([
    ["invalid JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a non-array allow list", JSON.stringify({ permissions: { allow: "Bash" } })],
  ])("fails the boot step on %s", async (_label, settings) => {
    const { ok, logs, io } = await runStep(
      { ...baseEnv, AGENT_ID: "agent-1" },
      {
        io: settingsIo(settings),
        fetch: async () => jsonResponse({ servers: [{ name: "github" }] }),
      },
    );

    expect(ok).toBe(false);
    expect(logs.at(-1)).toContain("[entrypoint] FATAL: MCP config step failed:");
    // The project config is written before the settings merge, matching the old shell order.
    expect(io.files.has(`${WORKSPACE}/.mcp.json`)).toBe(true);
    expect(io.files.get(SETTINGS_PATH)).toBe(settings);
  });

  test("fails the boot step when a write fails", async () => {
    const io = memoryIo();
    io.writeTextFile = async () => {
      throw new Error("EROFS: read-only file system");
    };
    const { ok, logs } = await runStep(baseEnv, { io });

    expect(ok).toBe(false);
    expect(logs.at(-1)).toBe(
      "[entrypoint] FATAL: MCP config step failed: EROFS: read-only file system; exiting.",
    );
  });
});

let helperDir: string;
let helperPath: string;

beforeAll(async () => {
  helperDir = await mkdtemp(join(tmpdir(), "swarm-mcp-config-"));
  helperPath = join(helperDir, "entrypoint-mcp-config.ts");
  // Copy only the file shipped by each image: no repo imports or node_modules.
  await Bun.write(helperPath, Bun.file(`${import.meta.dir}/../commands/entrypoint-mcp-config.ts`));
});

afterAll(async () => {
  await rm(helperDir, { recursive: true, force: true });
});

function extractConfigureMcpConfig(): string {
  const script = readFileSync(entrypointPath, "utf8");

  const beginMarker = "# BEGIN configure_mcp_config";
  const beginIndex = script.indexOf(beginMarker);
  if (beginIndex === -1) {
    throw new Error(
      "Could not locate `# BEGIN configure_mcp_config` marker in docker-entrypoint.sh — did the MCP config step move?",
    );
  }

  const funcStart = script.indexOf("configure_mcp_config() {", beginIndex);
  if (funcStart === -1) {
    throw new Error("Could not locate `configure_mcp_config() {` after the BEGIN marker.");
  }

  const endMarker = "# END configure_mcp_config";
  const endIndex = script.indexOf(endMarker, funcStart);
  if (endIndex === -1) {
    throw new Error("Could not locate `# END configure_mcp_config` in docker-entrypoint.sh.");
  }

  return script
    .slice(funcStart, endIndex)
    .replace("/usr/local/bin/bun", '"$2"')
    .replace("/usr/local/lib/agent-swarm/entrypoint-mcp-config.ts", '"$3"')
    .replace('"$HOME"', '"$1"')
    .replace('"/workspace"', '"$4"')
    .replace('"$MCP_URL"', '"$5"');
}

/**
 * Run the real extracted shim function against temporary home and workspace dirs.
 * `MCP_URL` is resolved from `MCP_BASE_URL` exactly like the entrypoint does, as a
 * shell-local: the helper must receive it as an argument, not from the environment.
 */
async function runShim(options: {
  home: string;
  workspace: string;
  env: Record<string, string>;
  mcpBaseUrl: string;
  apiKey?: string;
}): Promise<Awaited<ReturnType<typeof runChild>>> {
  const funcSrc = extractConfigureMcpConfig();
  const script = [
    "set -e",
    // Shell-local, exactly like the entrypoint's resolved MCP_URL: never exported.
    'MCP_URL="$5"',
    funcSrc,
    'configure_mcp_config "$1" "$2" "$3" "$4" "$MCP_URL"',
    "echo 'boot continued'",
    "",
  ].join("\n");
  return runChild(
    [
      "bash",
      "-c",
      script,
      "bash",
      options.home,
      process.execPath,
      helperPath,
      options.workspace,
      options.mcpBaseUrl,
    ],
    {
      cwd: helperDir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: options.home,
        API_KEY: options.apiKey ?? "",
        MCP_BASE_URL: options.mcpBaseUrl,
        ...options.env,
      },
    },
  );
}

async function createDirs(): Promise<{ home: string; workspace: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "swarm-mcp-shim-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { home, workspace, root };
}

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("configure_mcp_config: source contract", () => {
  test("the shell step hands the API key to the helper on stdin, never argv", () => {
    const funcSrc = extractConfigureMcpConfig();
    expect(funcSrc).toContain(`printf '%s' "$API_KEY" |`);
    const invocation = funcSrc.slice(
      funcSrc.indexOf("/usr/local/lib/agent-swarm/entrypoint-mcp-config.ts"),
    );
    expect(invocation).not.toContain("$API_KEY");
  });

  test("the MCP config logic no longer runs in Bash", () => {
    // Normalize CRLF so the assertions hold on a Windows checkout as well as in CI.
    const script = readFileSync(entrypointPath, "utf8").replaceAll("\r\n", "\n");
    expect(script).toContain("\nconfigure_mcp_config\n");
    expect(script).not.toContain("MCP_SERVERS_RESPONSE");
    expect(script).not.toContain("UPDATED_SETTINGS");
  });

  test("passes the resolved MCP URL as an argument and uses the image's Bun", () => {
    const script = readFileSync(entrypointPath, "utf8").replaceAll("\r\n", "\n");
    // MCP_URL is a shell-local in the entrypoint, so it must travel as an argument.
    expect(script).toContain('"/workspace" "$MCP_URL"');
    expect(script).toContain("/usr/local/bin/bun --no-orphans");
  });
});

describe("configure_mcp_config: real shim", () => {
  test(
    "writes the project config and merges installed-server permission patterns",
    async () => {
      const { home, workspace, root } = await createDirs();
      let authorization: string | null | undefined;
      let requestedPath = "";
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          requestedPath = new URL(req.url).pathname;
          authorization = req.headers.get("authorization");
          return jsonResponse({ servers: [{ name: "github" }] });
        },
      });
      await writeFile(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: ["Bash"] } }),
      );

      const result = await runShim({
        home,
        workspace,
        apiKey: "shim-secret-key",
        mcpBaseUrl: server.url.origin,
        env: {
          HARNESS_PROVIDER: "claude",
          AGENT_ID: "agent-1",
          // Decoy: the helper must take the URL from the resolved argument, not the env.
          MCP_URL: "http://decoy.invalid",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(requestedPath).toBe("/api/agents/agent-1/mcp-servers");
      expect(authorization).toBe("Bearer shim-secret-key");
      expect(result.stdout).toContain("Creating MCP config in");
      expect(result.stdout).toContain("Fetching installed MCP server names");
      expect(result.stdout).toContain("Found 1 installed MCP server(s)");
      expect(result.stdout).toContain("Adding MCP server permission patterns to settings.json");
      expect(result.stdout).toContain("boot continued");
      expect(result.stdout).not.toContain("shim-secret-key");
      expect(result.stderr).not.toContain("shim-secret-key");

      const config = JSON.parse(await readFile(join(workspace, ".mcp.json"), "utf8"));
      expect(config.mcpServers["agent-swarm"]).toEqual({
        type: "http",
        url: `${server.url.origin}/mcp`,
        headers: { Authorization: "Bearer shim-secret-key", "X-Agent-ID": "agent-1" },
      });
      const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
      expect(settings.permissions.allow).toEqual(["Bash", "mcp__github__*"]);

      await rm(root, { recursive: true, force: true });
    },
    TEST_TIMEOUT,
  );

  test(
    "skips the file for claude-managed",
    async () => {
      const { home, workspace, root } = await createDirs();

      const result = await runShim({
        home,
        workspace,
        mcpBaseUrl: "http://unused.invalid",
        env: { HARNESS_PROVIDER: "claude-managed" },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "Skipping local .mcp.json (claude-managed reads MCP from agent definition)",
      );
      expect(result.stdout).toContain("boot continued");
      const config = await readFile(join(workspace, ".mcp.json"), "utf8").catch(() => "missing");
      expect(config).toBe("missing");

      await rm(root, { recursive: true, force: true });
    },
    TEST_TIMEOUT,
  );

  test(
    "aborts the boot on a malformed settings.json after writing the project config",
    async () => {
      const { home, workspace, root } = await createDirs();
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => jsonResponse({ servers: [{ name: "github" }] }),
      });
      await writeFile(join(home, ".claude", "settings.json"), "{not json");

      const result = await runShim({
        home,
        workspace,
        apiKey: "shim-secret-key",
        mcpBaseUrl: server.url.origin,
        env: { HARNESS_PROVIDER: "claude", AGENT_ID: "agent-1" },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("[entrypoint] FATAL: MCP config step failed:");
      expect(result.stdout).not.toContain("boot continued");
      expect(await readFile(join(workspace, ".mcp.json"), "utf8")).toContain("agent-swarm");
      expect(await readFile(join(home, ".claude", "settings.json"), "utf8")).toBe("{not json");

      await rm(root, { recursive: true, force: true });
    },
    TEST_TIMEOUT,
  );

  test(
    "continues the boot when the control-plane API is unreachable",
    async () => {
      const { home, workspace, root } = await createDirs();
      server = Bun.serve({ port: 0, fetch: () => new Response("unused") });
      const unreachable = `${server.url.origin}/missing`;
      await server.stop(true);
      server = undefined;

      const result = await runShim({
        home,
        workspace,
        apiKey: "shim-secret-key",
        mcpBaseUrl: unreachable,
        env: { HARNESS_PROVIDER: "codex", AGENT_ID: "agent-1" },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("boot continued");
      expect(result.stdout).not.toContain("FATAL");
      const config = JSON.parse(await readFile(join(workspace, ".mcp.json"), "utf8"));
      expect(config.mcpServers["agent-swarm"].url).toBe(`${unreachable}/mcp`);

      await rm(root, { recursive: true, force: true });
    },
    TEST_TIMEOUT,
  );

  test(
    "uses the image's Bun even when a worker-writable PATH shadows bun",
    async () => {
      const { home, workspace, root } = await createDirs();
      const shadow = join(helperDir, "bun");
      await Bun.write(shadow, "#!/bin/sh\necho 'untrusted bun was executed'\nexit 99\n");
      await chmod(shadow, 0o755);

      const result = await runShim({
        home,
        workspace,
        mcpBaseUrl: "http://unused.invalid",
        env: {
          PATH: `${helperDir}:${process.env.PATH ?? ""}`,
          HARNESS_PROVIDER: "claude",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("untrusted bun was executed");
      expect(result.stdout).toContain("boot continued");

      await rm(root, { recursive: true, force: true });
    },
    TEST_TIMEOUT,
  );
});
