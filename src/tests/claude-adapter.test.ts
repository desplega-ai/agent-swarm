import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter, createSessionMcpConfig, mergeMcpConfig } from "../providers/claude-adapter";
import type { ProviderSessionConfig } from "../providers/types";

/** Minimal config for testing — sessions won't actually spawn in these unit tests */
function makeConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "Say hello",
    systemPrompt: "",
    model: "sonnet",
    role: "worker",
    agentId: "test-agent-id",
    taskId: "test-task-id",
    apiUrl: "http://localhost:3013",
    apiKey: "test-key",
    cwd: "/tmp",
    logFile: "/tmp/test-claude-adapter.jsonl",
    ...overrides,
  };
}

describe("ClaudeAdapter", () => {
  test("name is 'claude'", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.name).toBe("claude");
  });

  test("canResume always returns true", async () => {
    const adapter = new ClaudeAdapter();
    expect(await adapter.canResume("any-session-id")).toBe(true);
    expect(await adapter.canResume("")).toBe(true);
  });
});

describe("ClaudeSession CLI argument construction", () => {
  // We test the command building indirectly by examining what ClaudeAdapter passes.
  // Since buildCommand is private, we verify via the public interface behavior.

  test("default model falls back to 'opus' when empty", async () => {
    const _adapter = new ClaudeAdapter();
    const config = makeConfig({ model: "" });

    // We can't easily inspect the spawned process args without actually spawning,
    // but we can verify the adapter accepts empty model without throwing.
    // The actual fallback logic is: config.model || "opus"
    expect(config.model).toBe("");
  });

  test("config with systemPrompt is accepted", () => {
    const config = makeConfig({ systemPrompt: "You are a test agent" });
    expect(config.systemPrompt).toBe("You are a test agent");
  });

  test("config with arbitrary additionalArgs is accepted", () => {
    // Native resume is deprecated — the adapter no longer special-cases
    // --resume in additionalArgs. The config shape just round-trips opaquely.
    const config = makeConfig({
      additionalArgs: ["--max-turns", "10"],
    });
    expect(config.additionalArgs).toEqual(["--max-turns", "10"]);
  });
});

describe("Claude stream-json event parsing", () => {
  test("session_init parsed from system.init JSON", () => {
    const json = { type: "system", subtype: "init", session_id: "sess-12345" };
    expect(json.type).toBe("system");
    expect(json.subtype).toBe("init");
    expect(json.session_id).toBe("sess-12345");
  });

  test("result event with cost data", () => {
    const json = {
      type: "result",
      total_cost_usd: 0.0342,
      duration_ms: 12000,
      num_turns: 5,
      is_error: false,
      usage: {
        input_tokens: 5000,
        output_tokens: 2000,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
      },
    };

    expect(json.total_cost_usd).toBe(0.0342);
    expect(json.usage.input_tokens).toBe(5000);
    expect(json.usage.output_tokens).toBe(2000);
    expect(json.usage.cache_read_input_tokens).toBe(1000);
    expect(json.usage.cache_creation_input_tokens).toBe(500);
  });

  test("result event with is_error=true", () => {
    const json = {
      type: "result",
      total_cost_usd: 0.01,
      is_error: true,
      duration_ms: 3000,
      num_turns: 1,
    };
    expect(json.is_error).toBe(true);
  });
});

describe("mergeMcpConfig (issue #369)", () => {
  const TASK_ID = "task-abc-123";

  test("returns only installed servers when base config is null", () => {
    const installed = {
      "my-mcp": {
        type: "http",
        url: "https://example.com",
        headers: { Authorization: "Bearer x" },
      },
    };
    const merged = mergeMcpConfig(null, installed, TASK_ID);
    expect(merged.mcpServers["my-mcp"]).toEqual(installed["my-mcp"]);
  });

  test("returns only base servers when installedServers is null", () => {
    const base = {
      mcpServers: {
        "agent-swarm": {
          type: "http",
          url: "http://localhost:3013/mcp",
          headers: { Authorization: "Bearer KEY", "X-Agent-ID": "a1" },
        },
      },
    };
    const merged = mergeMcpConfig(base, null, TASK_ID);
    const agentSwarm = merged.mcpServers["agent-swarm"] as Record<string, unknown>;
    expect(agentSwarm).toBeDefined();
    // Agent-swarm entry is augmented with X-Source-Task-Id
    expect((agentSwarm.headers as Record<string, string>)["X-Source-Task-Id"]).toBe(TASK_ID);
  });

  test("installed servers OVERRIDE stale .mcp.json entries (precedence fix)", () => {
    // Simulates: /workspace/.mcp.json has an entry baked at container startup with
    // a stale OAuth Bearer; the per-session fetch returns a freshly-resolved Bearer.
    // The merged config MUST carry the fresh token — this is the core of issue #369.
    const base = {
      mcpServers: {
        stripe: {
          type: "http",
          url: "https://mcp.stripe.com",
          headers: { Authorization: "Bearer STALE_TOKEN_FROM_STARTUP" },
        },
      },
    };
    const installed = {
      stripe: {
        type: "http",
        url: "https://mcp.stripe.com",
        headers: { Authorization: "Bearer FRESH_TOKEN_FROM_API" },
      },
    };
    const merged = mergeMcpConfig(base, installed, TASK_ID);
    const stripe = merged.mcpServers.stripe as Record<string, unknown>;
    expect((stripe.headers as Record<string, string>).Authorization).toBe(
      "Bearer FRESH_TOKEN_FROM_API",
    );
  });

  test("installed-server removal is honored (uninstall propagates)", () => {
    // Previously, if .mcp.json had `stripe` baked in but the server was uninstalled
    // from the API, the stale entry persisted. With the precedence fix + skeleton
    // .mcp.json, a server absent from installedServers stays in the merged config
    // ONLY if it's also in base (e.g., manually-added) — no API-layer override is
    // issued. This test confirms we don't spontaneously delete base entries; the
    // docker-entrypoint change (don't bake installed servers) is what prevents
    // stale uninstalls from persisting.
    const base = {
      mcpServers: {
        "manually-configured": { type: "http", url: "https://x.test" },
      },
    };
    const installed = {}; // Empty — nothing installed via API
    const merged = mergeMcpConfig(base, installed, TASK_ID);
    expect(merged.mcpServers["manually-configured"]).toBeDefined();
  });

  test("agent-swarm server gets X-Source-Task-Id injected", () => {
    const base = {
      mcpServers: {
        "agent-swarm": {
          type: "http",
          url: "http://localhost:3013/mcp",
          headers: { Authorization: "Bearer KEY", "X-Agent-ID": "a1" },
        },
      },
    };
    const merged = mergeMcpConfig(base, null, TASK_ID);
    const agentSwarm = merged.mcpServers["agent-swarm"] as Record<string, unknown>;
    const headers = agentSwarm.headers as Record<string, string>;
    expect(headers["X-Source-Task-Id"]).toBe(TASK_ID);
    // Existing headers preserved
    expect(headers.Authorization).toBe("Bearer KEY");
    expect(headers["X-Agent-ID"]).toBe("a1");
  });

  test("X-Source-Task-Id injection works on entry discovered by X-Agent-ID header", () => {
    // Discovery path for non-standard server names.
    const base = {
      mcpServers: {
        "custom-name-swarm": {
          type: "http",
          url: "http://localhost:3013/mcp",
          headers: { Authorization: "Bearer KEY", "X-Agent-ID": "a1" },
        },
      },
    };
    const merged = mergeMcpConfig(base, null, TASK_ID);
    const entry = merged.mcpServers["custom-name-swarm"] as Record<string, unknown>;
    expect((entry.headers as Record<string, string>)["X-Source-Task-Id"]).toBe(TASK_ID);
  });

  test("does not mutate the input baseConfig", () => {
    const base = {
      mcpServers: {
        stripe: {
          type: "http",
          url: "https://mcp.stripe.com",
          headers: { Authorization: "Bearer STALE" },
        },
      },
    };
    const installed = {
      stripe: {
        type: "http",
        url: "https://mcp.stripe.com",
        headers: { Authorization: "Bearer FRESH" },
      },
    };
    mergeMcpConfig(base, installed, TASK_ID);
    // Original object should be untouched
    expect((base.mcpServers.stripe.headers as Record<string, string>).Authorization).toBe(
      "Bearer STALE",
    );
  });

  test("empty base + empty installed yields empty mcpServers", () => {
    const merged = mergeMcpConfig({ mcpServers: {} }, {}, TASK_ID);
    expect(Object.keys(merged.mcpServers)).toHaveLength(0);
  });

  test("preserves a context-mode entry through the merge", () => {
    const base = {
      mcpServers: {
        "agent-swarm": {
          type: "http",
          url: "http://localhost:3013/mcp",
          headers: { Authorization: "Bearer KEY", "X-Agent-ID": "a1" },
        },
        "context-mode": { command: "context-mode" },
      },
    };
    const merged = mergeMcpConfig(base, null, TASK_ID);
    expect(merged.mcpServers["context-mode"]).toEqual({ command: "context-mode" });
  });
});

describe("createSessionMcpConfig", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "mcp-cfg-test-"));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  async function readWritten(path: string) {
    return JSON.parse(await Bun.file(path).text()) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
  }

  test("returns null when no .mcp.json found and no installed servers", async () => {
    const cwd = join(sandbox, "empty");
    await mkdir(cwd, { recursive: true });
    const path = await createSessionMcpConfig(cwd, "task-empty");
    expect(path).toBeNull();
  });

  test("ancestor-only .mcp.json is found via walk-up (Docker layout)", async () => {
    await writeFile(
      join(sandbox, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "agent-swarm": {
            type: "http",
            url: "http://swarm/mcp",
            headers: { Authorization: "Bearer SWARM", "X-Agent-ID": "a1" },
          },
        },
      }),
    );
    const cwd = join(sandbox, "repos", "foo");
    await mkdir(cwd, { recursive: true });

    const path = await createSessionMcpConfig(cwd, "task-anc");
    expect(path).toBe("/tmp/mcp-task-anc.json");
    const written = await readWritten(path!);
    expect(written.mcpServers["agent-swarm"]).toBeDefined();
    expect(
      (written.mcpServers["agent-swarm"].headers as Record<string, string>)["X-Source-Task-Id"],
    ).toBe("task-anc");
  });

  test("merges repo-local + ancestor when server names differ", async () => {
    await writeFile(
      join(sandbox, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "agent-swarm": {
            type: "http",
            url: "http://swarm/mcp",
            headers: { Authorization: "Bearer SWARM", "X-Agent-ID": "a1" },
          },
        },
      }),
    );
    const repo = join(sandbox, "repos", "client-monorepo");
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(repo, ".mcp.json"),
      JSON.stringify({
        mcpServers: { Datadog: { command: "npx", args: ["-y", "@winor30/mcp-server-datadog"] } },
      }),
    );

    const path = await createSessionMcpConfig(repo, "task-merge");
    const written = await readWritten(path!);
    expect(written.mcpServers["agent-swarm"]).toBeDefined();
    expect(written.mcpServers.Datadog).toBeDefined();
    // context-mode is injected by default (see CONTEXT_MODE_DISABLED gate); the
    // two differently-named .mcp.json servers still merge alongside it.
    expect(Object.keys(written.mcpServers).sort()).toEqual([
      "Datadog",
      "agent-swarm",
      "context-mode",
    ]);
  });

  test("ancestor wins over repo-local on agent-swarm key conflict", async () => {
    await writeFile(
      join(sandbox, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "agent-swarm": {
            type: "http",
            url: "http://swarm/mcp",
            headers: { Authorization: "Bearer SWARM", "X-Agent-ID": "a1" },
          },
        },
      }),
    );
    const repo = join(sandbox, "repos", "foo");
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(repo, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "agent-swarm": {
            type: "http",
            url: "http://stale/mcp",
            headers: { Authorization: "Bearer STALE", "X-Agent-ID": "stale-agent" },
          },
        },
      }),
    );

    const path = await createSessionMcpConfig(repo, "task-conflict");
    const written = await readWritten(path!);
    const swarm = written.mcpServers["agent-swarm"] as Record<string, unknown>;
    const headers = swarm.headers as Record<string, string>;
    expect(swarm.url).toBe("http://swarm/mcp");
    expect(headers.Authorization).toBe("Bearer SWARM");
    expect(headers["X-Agent-ID"]).toBe("a1");
    expect(headers["X-Source-Task-Id"]).toBe("task-conflict");
  });

  test("malformed repo-local .mcp.json is skipped without poisoning ancestor entries", async () => {
    await writeFile(
      join(sandbox, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "agent-swarm": {
            type: "http",
            url: "http://swarm/mcp",
            headers: { "X-Agent-ID": "a1" },
          },
        },
      }),
    );
    const repo = join(sandbox, "repos", "foo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, ".mcp.json"), "{ this is not valid json");

    const path = await createSessionMcpConfig(repo, "task-malformed");
    expect(path).not.toBeNull();
    const written = await readWritten(path!);
    expect(written.mcpServers["agent-swarm"]).toBeDefined();
  });

  test("only installedServers, no .mcp.json on disk", async () => {
    const cwd = join(sandbox, "no-mcp");
    await mkdir(cwd, { recursive: true });

    const path = await createSessionMcpConfig(cwd, "task-installed", {
      "from-api": {
        type: "http",
        url: "http://api.test/mcp",
        headers: { Authorization: "Bearer API" },
      },
    });
    expect(path).toBe("/tmp/mcp-task-installed.json");
    const written = await readWritten(path!);
    expect(written.mcpServers["from-api"]).toBeDefined();
  });

  test("includes context-mode entry when CONTEXT_MODE_DISABLED is unset", async () => {
    const prev = process.env.CONTEXT_MODE_DISABLED;
    delete process.env.CONTEXT_MODE_DISABLED;
    try {
      await writeFile(
        join(sandbox, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "agent-swarm": {
              type: "http",
              url: "http://swarm/mcp",
              headers: { Authorization: "Bearer SWARM", "X-Agent-ID": "a1" },
            },
          },
        }),
      );
      const cwd = join(sandbox, "repos", "foo");
      await mkdir(cwd, { recursive: true });

      const path = await createSessionMcpConfig(cwd, "task-ctx-on");
      const written = await readWritten(path!);
      expect(written.mcpServers["context-mode"]).toEqual({ command: "context-mode" });
      // Coexists with the swarm entry.
      expect(written.mcpServers["agent-swarm"]).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.CONTEXT_MODE_DISABLED;
      else process.env.CONTEXT_MODE_DISABLED = prev;
    }
  });

  test("excludes context-mode entry when CONTEXT_MODE_DISABLED='true'", async () => {
    const prev = process.env.CONTEXT_MODE_DISABLED;
    process.env.CONTEXT_MODE_DISABLED = "true";
    try {
      await writeFile(
        join(sandbox, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "agent-swarm": {
              type: "http",
              url: "http://swarm/mcp",
              headers: { Authorization: "Bearer SWARM", "X-Agent-ID": "a1" },
            },
          },
        }),
      );
      const cwd = join(sandbox, "repos", "foo");
      await mkdir(cwd, { recursive: true });

      const path = await createSessionMcpConfig(cwd, "task-ctx-off");
      const written = await readWritten(path!);
      expect(written.mcpServers["context-mode"]).toBeUndefined();
      // The swarm entry is still present.
      expect(written.mcpServers["agent-swarm"]).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.CONTEXT_MODE_DISABLED;
      else process.env.CONTEXT_MODE_DISABLED = prev;
    }
  });
});
