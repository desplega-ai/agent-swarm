import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  applyResolvedEnvToProcessEnv,
  fetchRepoConfig,
  fetchResolvedEnv,
  RELOADABLE_ENV_KEYS,
} from "../commands/runner";

/**
 * Tests for the fetchResolvedEnv() / applyResolvedEnvToProcessEnv() behavior
 * used in runner.ts, exercised against the real (exported) implementations
 * rather than a hand-maintained replica — see issue #1102 bug 2, where a
 * replica of this exact logic could pass while the real implementation
 * silently cleared a container-provided value.
 */

let server: ReturnType<typeof Bun.serve>;
let testUrl: string;

type MockResponse = { status: number; body: unknown };

const defaultMockResponse: MockResponse = {
  status: 200,
  body: { configs: [] },
};
const mockResponsesByAgentId = new Map<string, MockResponse>();
const requestedRepoIds = new Map<string, string | null>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/config/resolved") {
        const agentId = url.searchParams.get("agentId") ?? "";
        requestedRepoIds.set(agentId, url.searchParams.get("repoId"));
        const mockResponse = mockResponsesByAgentId.get(agentId) ?? defaultMockResponse;
        return new Response(JSON.stringify(mockResponse.body), {
          status: mockResponse.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });
  testUrl = server.url.toString().replace(/\/$/, "");
});

afterAll(() => {
  server.stop(true);
});

describe("fetchResolvedEnv", () => {
  test("repository scope requires the requested repository identity", async () => {
    const repoId = crypto.randomUUID();
    let url = "https://github.com/another-owner/fixture";
    const api = Bun.serve({
      port: 0,
      fetch: () => Response.json({ repos: [{ id: repoId, url, name: "fixture" }] }),
    });
    try {
      expect(
        await fetchRepoConfig(api.url.toString(), "fixture", "owner/fixture", true),
      ).toBeNull();
      url = "https://github.com/owner/fixture-extra";
      expect(
        await fetchRepoConfig(api.url.toString(), "fixture", "owner/fixture", true),
      ).toBeNull();
      for (const repositoryUrl of [
        "https://github.com/owner/fixture.git",
        "git@github.com:owner/fixture.git",
      ]) {
        url = repositoryUrl;
        expect(
          (await fetchRepoConfig(api.url.toString(), "fixture", "owner/fixture", true))?.id,
        ).toBe(repoId);
      }
    } finally {
      api.stop(true);
    }
  });

  test("resolves full repository URLs and normalizes the API name filter", async () => {
    const repoId = crypto.randomUUID();
    let registeredUrl = "https://github.com/owner/fixture.git";
    const requestedNames: Array<string | null> = [];
    const api = Bun.serve({
      port: 0,
      fetch(req) {
        const name = new URL(req.url).searchParams.get("name");
        requestedNames.push(name);
        return Response.json({
          repos: name === "fixture" ? [{ id: repoId, url: registeredUrl, name: "fixture" }] : [],
        });
      },
    });
    try {
      for (const requested of [
        "https://github.com/owner/fixture",
        "https://github.com/owner/fixture.git",
        "https://github.com/owner/fixture.git/",
        "owner/fixture.git/",
      ]) {
        expect((await fetchRepoConfig(api.url.toString(), "fixture", requested, true))?.id).toBe(
          repoId,
        );
      }
      registeredUrl = "git@github.com:owner/fixture.git";
      expect((await fetchRepoConfig(api.url.toString(), "fixture", registeredUrl, true))?.id).toBe(
        repoId,
      );
      registeredUrl = "https://another-host.test/owner/fixture";
      expect(
        await fetchRepoConfig(
          api.url.toString(),
          "fixture",
          "https://github.com/owner/fixture",
          true,
        ),
      ).toBeNull();
      expect(requestedNames.every((name) => name === "fixture")).toBe(true);
    } finally {
      api.stop(true);
    }
  });

  test("passes repository scope and restores the transport default after deletion", async () => {
    const agentId = crypto.randomUUID();
    const repoId = crypto.randomUUID();
    const baseEnv = { CLAUDE_TRANSPORT: "cli" };
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "CLAUDE_TRANSPORT", value: "sdk" }] },
    });
    const assigned = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv, undefined, {
      repoId,
    });
    expect(requestedRepoIds.get(agentId)).toBe(repoId);
    expect(assigned.env.CLAUDE_TRANSPORT).toBe("sdk");
    expect(baseEnv.CLAUDE_TRANSPORT).toBe("cli");
    expect(RELOADABLE_ENV_KEYS.has("CLAUDE_TRANSPORT")).toBe(false);

    mockResponsesByAgentId.set(agentId, { status: 200, body: { configs: [] } });
    const inherited = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);
    expect(inherited.env.CLAUDE_TRANSPORT).toBe("cli");
    expect(requestedRepoIds.get(agentId)).toBeNull();
  });

  test("selects both Claude credential pools for the executing adapter despite repository harness config", async () => {
    const agentId = crypto.randomUUID();
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: {
        configs: [
          { key: "HARNESS_PROVIDER", value: "codex" },
          { key: "CLAUDE_CODE_OAUTH_TOKEN", value: "fixture-oauth-a,fixture-oauth-b" },
          { key: "ANTHROPIC_API_KEY", value: "fixture-api-a,fixture-api-b" },
          { key: "CLAUDE_TRANSPORT", value: "sdk" },
        ],
      },
    });
    const result = await fetchResolvedEnv(testUrl, "key", agentId, {}, "claude-haiku-4-5", {
      repoId: crypto.randomUUID(),
      provider: "claude",
    });
    expect(result.resolvedProvider).toBe("claude");
    expect(result.env.HARNESS_PROVIDER).toBe("claude");
    expect(result.env.CLAUDE_TRANSPORT).toBe("sdk");
    expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^fixture-oauth-[ab]$/);
    expect(result.env.ANTHROPIC_API_KEY).toMatch(/^fixture-api-[ab]$/);
    expect(result.credentialSelections.map((selection) => selection.keyType)).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
  });

  test("returns baseEnv when apiUrl is empty", async () => {
    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv("", "key", "agent-1", baseEnv);
    expect(result.env).toEqual({ EXISTING: "value" });
  });

  test("returns baseEnv when agentId is empty", async () => {
    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv(testUrl, "key", "", baseEnv);
    expect(result.env).toEqual({ EXISTING: "value" });
  });

  test("merges API config over baseEnv", async () => {
    const agentId = "agent-merge";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: {
        configs: [
          { key: "NEW_VAR", value: "from-api" },
          { key: "OVERRIDE_VAR", value: "api-wins" },
        ],
      },
    });

    const baseEnv = { EXISTING: "keep", OVERRIDE_VAR: "original" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    expect(result.env.EXISTING).toBe("keep");
    expect(result.env.NEW_VAR).toBe("from-api");
    expect(result.env.OVERRIDE_VAR).toBe("api-wins");
  });

  test("returns baseEnv when API returns empty configs", async () => {
    const agentId = "agent-empty";
    mockResponsesByAgentId.set(agentId, { status: 200, body: { configs: [] } });

    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);
    expect(result.env).toEqual({ EXISTING: "value" });
  });

  test("returns baseEnv when API returns non-200", async () => {
    const agentId = "agent-500";
    mockResponsesByAgentId.set(agentId, { status: 500, body: { error: "server error" } });

    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);
    expect(result.env).toEqual({ EXISTING: "value" });
  });

  test("returns baseEnv when API is unreachable", async () => {
    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv("http://localhost:19999", "key", "agent-1", baseEnv);
    expect(result.env).toEqual({ EXISTING: "value" });
  });

  test("does not mutate the baseEnv object", async () => {
    const agentId = "agent-mutation";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "NEW_VAR", value: "new" }] },
    });

    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    // baseEnv should be untouched
    expect(baseEnv).toEqual({ EXISTING: "value" });
    expect(result.env.NEW_VAR).toBe("new");
  });

  test("handles multiple configs correctly", async () => {
    const agentId = "agent-multiple";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: {
        configs: [
          { key: "VAR_A", value: "a" },
          { key: "VAR_B", value: "b" },
          { key: "VAR_C", value: "c" },
        ],
      },
    });

    const result = await fetchResolvedEnv(testUrl, "key", agentId, {});
    expect(result.env.VAR_A).toBe("a");
    expect(result.env.VAR_B).toBe("b");
    expect(result.env.VAR_C).toBe("c");
  });

  // ─── Issue #1102 bug 2 regression coverage ──────────────────────────────
  //
  // A container-provided value for a model-control key (MODEL_OVERRIDE,
  // REASONING_EFFORT_OVERRIDE — e.g. `docker run -e MODEL_OVERRIDE=...`)
  // must survive a config reload even when swarm_config holds a BLANK row
  // for that key. Nothing writes an intentionally-empty row through the
  // dedicated tri-state endpoint (it DELETEs to clear — see
  // `updateAgentRuntimeRoute` in src/http/agents.ts), so a blank row can
  // only be a stray write via the generic `PUT /api/config` (which accepts
  // `value: z.unknown()`); treating it the same as "no row" for these keys
  // closes that gap.
  //
  // This protection is intentionally narrower than the full
  // RELOADABLE_ENV_KEYS set: other reloadable keys (MEMORY_RATERS,
  // SLACK_DISABLE, etc.) are written through the generic config-page path,
  // where a blank row IS a meaningful, intentional value an operator can
  // set on purpose (e.g. `MEMORY_RATERS=""` is the documented way to run no
  // raters even when the container sets `MEMORY_RATERS=llm` — see
  // getRegisteredRaters in src/be/memory/raters/registry.ts). Guarding
  // those too would silently ignore a real operator override.

  test("a blank swarm_config value for MODEL_OVERRIDE does not clear the container-provided value", async () => {
    expect(RELOADABLE_ENV_KEYS.has("MODEL_OVERRIDE")).toBe(true);

    const agentId = "agent-blank-model-override";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "MODEL_OVERRIDE", value: "" }] },
    });

    const baseEnv = { MODEL_OVERRIDE: "openrouter/deepseek/deepseek-v4-flash" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    expect(result.env.MODEL_OVERRIDE).toBe("openrouter/deepseek/deepseek-v4-flash");
  });

  test("a blank swarm_config value for a non-reloadable key still overrides baseEnv (unchanged behavior)", async () => {
    const agentId = "agent-blank-nonreloadable";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "SOME_OTHER_VAR", value: "" }] },
    });

    const baseEnv = { SOME_OTHER_VAR: "container-value" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    // Only the RELOADABLE_ENV_KEYS floor is protected — every other config
    // key keeps today's "config store always wins" behavior.
    expect(result.env.SOME_OTHER_VAR).toBe("");
  });

  test("an explicit non-empty swarm_config value still overrides MODEL_OVERRIDE", async () => {
    const agentId = "agent-explicit-model-override";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "MODEL_OVERRIDE", value: "operator/explicit-model" }] },
    });

    const baseEnv = { MODEL_OVERRIDE: "container-value" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    expect(result.env.MODEL_OVERRIDE).toBe("operator/explicit-model");
  });

  test("a blank swarm_config value sets MODEL_OVERRIDE when there was no container value", async () => {
    const agentId = "agent-blank-no-base";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "MODEL_OVERRIDE", value: "" }] },
    });

    const result = await fetchResolvedEnv(testUrl, "key", agentId, {});

    expect(result.env.MODEL_OVERRIDE).toBe("");
  });

  test("a blank swarm_config value for REASONING_EFFORT_OVERRIDE does not clear the container-provided value", async () => {
    expect(RELOADABLE_ENV_KEYS.has("REASONING_EFFORT_OVERRIDE")).toBe(true);

    const agentId = "agent-blank-reasoning-effort";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "REASONING_EFFORT_OVERRIDE", value: "" }] },
    });

    const baseEnv = { REASONING_EFFORT_OVERRIDE: "high" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    expect(result.env.REASONING_EFFORT_OVERRIDE).toBe("high");
  });

  test("a blank swarm_config value for MEMORY_RATERS clears the container-provided value (disable-all-raters is a real, intentional operator state)", async () => {
    expect(RELOADABLE_ENV_KEYS.has("MEMORY_RATERS")).toBe(true);

    const agentId = "agent-blank-memory-raters";
    mockResponsesByAgentId.set(agentId, {
      status: 200,
      body: { configs: [{ key: "MEMORY_RATERS", value: "" }] },
    });

    // Container sets MEMORY_RATERS=llm; an operator explicitly saving a
    // blank value on the dashboard's Configuration page must be able to
    // turn raters off, not have the container value silently win.
    const baseEnv = { MEMORY_RATERS: "llm" };
    const result = await fetchResolvedEnv(testUrl, "key", agentId, baseEnv);

    expect(result.env.MEMORY_RATERS).toBe("");
  });
});

describe("applyResolvedEnvToProcessEnv", () => {
  const savedValues = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [key, value] of savedValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedValues.clear();
  });

  function snapshot(key: string) {
    if (!savedValues.has(key)) savedValues.set(key, process.env[key]);
  }

  test("does not clear process.env when freshEnv omits a reloadable key", () => {
    snapshot("MODEL_OVERRIDE");
    process.env.MODEL_OVERRIDE = "container-value";

    const changed = applyResolvedEnvToProcessEnv({});

    expect(changed).not.toContain("MODEL_OVERRIDE");
    expect(process.env.MODEL_OVERRIDE).toBe("container-value");
  });

  test("applies an explicit non-empty value for a reloadable key", () => {
    snapshot("MODEL_OVERRIDE");
    process.env.MODEL_OVERRIDE = "old-value";

    const changed = applyResolvedEnvToProcessEnv({ MODEL_OVERRIDE: "new-value" });

    expect(changed).toContain("MODEL_OVERRIDE");
    expect(process.env.MODEL_OVERRIDE).toBe("new-value");
  });
});
