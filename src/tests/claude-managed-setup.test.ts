import { describe, expect, mock, test } from "bun:test";

import {
  resolveClaudeManagedSetupConfig,
  runClaudeManagedSetup,
  runClaudeManagedSetupFlow,
} from "../commands/claude-managed-setup";

/**
 * Mocked-fetch / mocked-Anthropic-SDK tests for `claude-managed-setup`.
 *
 * Plan reference: Phase 2 §Automated QA — assert the setup flow hits
 * environments.create, skills.create (×N), agents.create, then PUT /api/config
 * for each ID, and is idempotent on re-run.
 */

// ─── Mock factories ──────────────────────────────────────────────────────────

function makeMockClient(overrides: Record<string, unknown> = {}) {
  const environmentsCreate = mock(async () => ({ id: "env_test_123" }));
  const skillsCreate = mock(async () => ({ id: "skill_test_abc" }));
  const agentsCreate = mock(async () => ({ id: "agent_test_xyz" }));

  const client = {
    beta: {
      environments: { create: environmentsCreate },
      skills: { create: skillsCreate },
      agents: { create: agentsCreate },
    },
    ...overrides,
  };
  return { client, environmentsCreate, skillsCreate, agentsCreate };
}

const baseConfig = {
  apiUrl: "http://localhost:3013",
  apiKey: "123123",
  anthropicApiKey: "sk-ant-test",
  mcpBaseUrl: "https://swarm.example.com",
  agentModel: "claude-sonnet-4-6",
  force: false,
};

const fakeSkillFiles = [
  { slug: "work-on-task", absPath: "/x/work-on-task.md", content: "# work-on-task\n" },
  { slug: "create-pr", absPath: "/x/create-pr.md", content: "# create-pr\n" },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runClaudeManagedSetupFlow — happy path", () => {
  test("calls environments.create, skills.create (xN), agents.create, then upserts 3 configs", async () => {
    const { client, environmentsCreate, skillsCreate, agentsCreate } = makeMockClient();

    const fetchConfig = mock(async () => null);
    const upsert = mock(async () => undefined);
    const loadSkills = mock(async () => fakeSkillFiles);
    const uploadOne = mock(async (_c: unknown, slug: string) => `skill_${slug}`);
    const log = mock((_msg: string) => undefined);

    const result = await runClaudeManagedSetupFlow(baseConfig, {
      // biome-ignore lint/suspicious/noExplicitAny: fake client subset for mock
      client: client as any,
      fetchConfig,
      upsert,
      loadSkills,
      uploadOne,
      log,
    });

    expect(result.alreadyConfigured).toBe(false);
    expect(result.agentId).toBe("agent_test_xyz");
    expect(result.environmentId).toBe("env_test_123");
    expect(result.skillIds).toEqual(["skill_work-on-task", "skill_create-pr"]);

    expect(environmentsCreate).toHaveBeenCalledTimes(1);
    const envCallArgs = environmentsCreate.mock.calls[0]?.[0] as {
      name: string;
      config: { type: string; networking: { type: string } };
    };
    expect(envCallArgs.name).toBe("swarm-worker-env");
    expect(envCallArgs.config.type).toBe("cloud");
    expect(envCallArgs.config.networking.type).toBe("unrestricted");

    expect(uploadOne).toHaveBeenCalledTimes(fakeSkillFiles.length);

    expect(agentsCreate).toHaveBeenCalledTimes(1);
    const agentCallArgs = agentsCreate.mock.calls[0]?.[0] as {
      name: string;
      model: string;
      tools: Array<{ type: string }>;
      skills: Array<{ type: string; skill_id: string }>;
      mcp_servers: Array<{ name: string; type: string; url: string }>;
    };
    expect(agentCallArgs.name).toBe("swarm-worker");
    expect(agentCallArgs.model).toBe("claude-sonnet-4-6");
    expect(agentCallArgs.tools[0]?.type).toBe("agent_toolset_20260401");
    expect(agentCallArgs.skills.map((s) => s.skill_id)).toEqual([
      "skill_work-on-task",
      "skill_create-pr",
    ]);
    expect(agentCallArgs.mcp_servers[0]?.url).toBe("https://swarm.example.com/mcp");

    // Three upserts: managed_agent_id, managed_environment_id, anthropic_api_key.
    expect(upsert).toHaveBeenCalledTimes(3);
    const upsertedKeys = upsert.mock.calls.map((c) => (c[2] as { key: string }).key);
    expect(new Set(upsertedKeys)).toEqual(
      new Set(["managed_agent_id", "managed_environment_id", "anthropic_api_key"]),
    );

    // Sensitive flags: anthropic_api_key isSecret=true; the IDs are not secret.
    const apiKeyEntry = upsert.mock.calls.find(
      (c) => (c[2] as { key: string }).key === "anthropic_api_key",
    );
    expect((apiKeyEntry?.[2] as { isSecret?: boolean }).isSecret).toBe(true);

    // Sky check skillsCreate was not called directly — uploadOne handles it
    expect(skillsCreate).not.toHaveBeenCalled();
  });

  test("strips trailing slash from mcpBaseUrl when building the MCP server URL", async () => {
    const { client, agentsCreate } = makeMockClient();
    await runClaudeManagedSetupFlow(
      { ...baseConfig, mcpBaseUrl: "https://swarm.example.com/" },
      {
        // biome-ignore lint/suspicious/noExplicitAny: fake client subset for mock
        client: client as any,
        fetchConfig: mock(async () => null),
        upsert: mock(async () => undefined),
        loadSkills: mock(async () => []),
        uploadOne: mock(async () => null),
        log: mock(() => undefined),
      },
    );
    const agentCallArgs = agentsCreate.mock.calls[0]?.[0] as {
      mcp_servers: Array<{ url: string }>;
    };
    expect(agentCallArgs.mcp_servers[0]?.url).toBe("https://swarm.example.com/mcp");
  });
});

describe("runClaudeManagedSetupFlow — idempotent re-run", () => {
  test("short-circuits with already-configured when managed_agent_id exists in swarm_config", async () => {
    const { client, environmentsCreate, agentsCreate } = makeMockClient();
    const fetchConfig = mock(async (_url: string, _key: string, key: string) => {
      if (key === "managed_agent_id") {
        return {
          scope: "global",
          key,
          value: "agent_already_there",
          isSecret: false,
        };
      }
      if (key === "managed_environment_id") {
        return {
          scope: "global",
          key,
          value: "env_already_there",
          isSecret: false,
        };
      }
      return null;
    });
    const upsert = mock(async () => undefined);
    const loadSkills = mock(async () => fakeSkillFiles);
    const uploadOne = mock(async () => null);

    const result = await runClaudeManagedSetupFlow(baseConfig, {
      // biome-ignore lint/suspicious/noExplicitAny: fake client subset for mock
      client: client as any,
      fetchConfig,
      upsert,
      loadSkills,
      uploadOne,
      log: mock(() => undefined),
    });

    expect(result.alreadyConfigured).toBe(true);
    expect(result.agentId).toBe("agent_already_there");
    expect(result.environmentId).toBe("env_already_there");

    // No Anthropic API calls.
    expect(environmentsCreate).not.toHaveBeenCalled();
    expect(agentsCreate).not.toHaveBeenCalled();
    // No swarm_config writes — IDs already there.
    expect(upsert).not.toHaveBeenCalled();
  });

  test("--force bypasses idempotency check", async () => {
    const { client, environmentsCreate, agentsCreate } = makeMockClient();
    const fetchConfig = mock(async () => ({
      scope: "global",
      key: "managed_agent_id",
      value: "agent_already_there",
      isSecret: false,
    }));
    const upsert = mock(async () => undefined);

    await runClaudeManagedSetupFlow(
      { ...baseConfig, force: true },
      {
        // biome-ignore lint/suspicious/noExplicitAny: fake client subset for mock
        client: client as any,
        fetchConfig,
        upsert,
        loadSkills: mock(async () => []),
        uploadOne: mock(async () => null),
        log: mock(() => undefined),
      },
    );

    expect(environmentsCreate).toHaveBeenCalledTimes(1);
    expect(agentsCreate).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(3);
    // fetchConfig should NOT be called when --force.
    expect(fetchConfig).not.toHaveBeenCalled();
  });
});

describe("resolveClaudeManagedSetupConfig", () => {
  test("uses defaults + env vars without prompts when not interactive", async () => {
    const promptSecret = mock(async () => {
      throw new Error("should not prompt");
    });
    const result = await resolveClaudeManagedSetupConfig([], {
      env: {
        ANTHROPIC_API_KEY: "sk-ant-from-env",
        MCP_BASE_URL: "https://example.com",
        API_KEY: "key123",
      },
      isInteractive: false,
      promptSecret,
    });
    expect(result.anthropicApiKey).toBe("sk-ant-from-env");
    expect(result.mcpBaseUrl).toBe("https://example.com");
    expect(result.apiKey).toBe("key123");
    expect(result.apiUrl).toBe("https://example.com");
    expect(result.agentModel).toBe("claude-sonnet-4-6");
    expect(promptSecret).not.toHaveBeenCalled();
  });

  test("rejects http:// MCP_BASE_URL fail-fast", async () => {
    await expect(
      resolveClaudeManagedSetupConfig([], {
        env: { ANTHROPIC_API_KEY: "sk-ant-x", MCP_BASE_URL: "http://insecure.local" },
        isInteractive: false,
      }),
    ).rejects.toThrow(/must start with https/);
  });

  test("rejects missing MCP_BASE_URL", async () => {
    await expect(
      resolveClaudeManagedSetupConfig([], {
        env: { ANTHROPIC_API_KEY: "sk-ant-x" },
        isInteractive: false,
      }),
    ).rejects.toThrow(/MCP_BASE_URL is not set/);
  });

  test("--force flag is parsed", async () => {
    const result = await resolveClaudeManagedSetupConfig(["--force"], {
      env: {
        ANTHROPIC_API_KEY: "sk-ant-x",
        MCP_BASE_URL: "https://example.com",
      },
      isInteractive: false,
    });
    expect(result.force).toBe(true);
  });
});

describe("runClaudeManagedSetup — entry point", () => {
  test("--help prints usage and returns without invoking the flow", async () => {
    const log = mock((_msg: string) => undefined);
    const errorFn = mock((_msg: string) => undefined);
    const exit = mock((_code: number) => {
      throw new Error("exit was called");
    });
    const flow = mock(async () => {
      throw new Error("flow should not be called");
    });
    const resolveConfig = mock(async () => {
      throw new Error("resolveConfig should not be called");
    });

    await runClaudeManagedSetup(["--help"], {
      log,
      error: errorFn,
      exit,
      flow,
      resolveConfig,
    });

    expect(flow).not.toHaveBeenCalled();
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test("on error, calls error() + exit(1) without throwing", async () => {
    const log = mock((_msg: string) => undefined);
    const errorMessages: string[] = [];
    const errorFn = (msg: string) => {
      errorMessages.push(msg);
    };
    let exitCode: number | null = null;
    const exit = (code: number) => {
      exitCode = code;
    };

    await runClaudeManagedSetup([], {
      resolveConfig: async () => {
        throw new Error("resolve fail");
      },
      flow: async () => {
        throw new Error("flow should not be called");
      },
      log,
      error: errorFn,
      exit,
    });

    expect(exitCode).toBe(1);
    expect(errorMessages.join("\n")).toMatch(/resolve fail/);
  });
});
