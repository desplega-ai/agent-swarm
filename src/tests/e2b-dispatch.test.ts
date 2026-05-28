import { describe, expect, test } from "bun:test";
import {
  buildDetachedShell,
  buildImageTemplate,
  buildTemplateArgs,
  deleteTemplate,
  type E2BSandboxInfo,
  e2bSdkConnectionOptions,
  sandboxPortHost,
  setTemplateVisibility,
  waitForAgentRegistration,
} from "../e2b/dispatch";
import {
  parseDotenv,
  parseKeyValue,
  redactObjectWithEnv,
  redactWithEnv,
  resolveSwarmApiKey,
  selectEnv,
} from "../e2b/env";

describe("E2B env helpers", () => {
  test("parses common dotenv forms", () => {
    expect(
      parseDotenv(`
        # ignored
        export API_KEY=abc123
        QUOTED="hello\\nworld"
        SINGLE='literal value'
        INLINE=value # comment
        QUOTED_COMMENT="bar" # comment
        SINGLE_COMMENT='baz' # comment
        QUOTED_HASH="bar # keep"
      `),
    ).toEqual({
      API_KEY: "abc123",
      QUOTED: "hello\nworld",
      SINGLE: "literal value",
      INLINE: "value",
      QUOTED_COMMENT: "bar",
      SINGLE_COMMENT: "baz",
      QUOTED_HASH: "bar # keep",
    });
  });

  test("validates KEY=VALUE inputs", () => {
    expect(parseKeyValue("FOO=bar=baz", "--secret")).toEqual(["FOO", "bar=baz"]);
    expect(() => parseKeyValue("bad-key=value", "--secret")).toThrow("invalid env key");
    expect(() => parseKeyValue("NOVALUE", "--secret")).toThrow("KEY=VALUE");
  });

  test("resolves swarm API key with env-file precedence before process default", () => {
    const previousApiKey = process.env.API_KEY;
    const previousNamespacedKey = process.env.AGENT_SWARM_API_KEY;
    delete process.env.API_KEY;
    delete process.env.AGENT_SWARM_API_KEY;
    try {
      expect(resolveSwarmApiKey({ API_KEY: "legacy", AGENT_SWARM_API_KEY: "preferred" })).toBe(
        "preferred",
      );
      expect(resolveSwarmApiKey({ API_KEY: "legacy" }, "explicit")).toBe("explicit");
      expect(() => resolveSwarmApiKey({})).toThrow("Missing swarm API key");
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.API_KEY;
      } else {
        process.env.API_KEY = previousApiKey;
      }
      if (previousNamespacedKey === undefined) {
        delete process.env.AGENT_SWARM_API_KEY;
      } else {
        process.env.AGENT_SWARM_API_KEY = previousNamespacedKey;
      }
    }
  });

  test("selectEnv and redactWithEnv keep secrets out of logs", () => {
    const selected = selectEnv(
      {
        API_KEY: "super-secret-value",
        E2B_API_KEY: "controller-secret",
        PATH: "/bin",
      },
      ["API_KEY", "PATH"],
    );
    expect(selected).toEqual({ API_KEY: "super-secret-value", PATH: "/bin" });
    expect(redactWithEnv("token=super-secret-value", selected)).toContain("[REDACTED:API_KEY]");
  });

  test("redactObjectWithEnv redacts token-like response fields", () => {
    expect(
      redactObjectWithEnv(
        {
          sandboxID: "sbx123",
          envdAccessToken: "controller-token-that-should-not-print",
          nested: { trafficAccessToken: "traffic-token-that-should-not-print" },
        },
        {},
      ),
    ).toEqual({
      sandboxID: "sbx123",
      envdAccessToken: "[REDACTED:envdAccessToken]",
      nested: { trafficAccessToken: "[REDACTED:trafficAccessToken]" },
    });
  });
});

describe("E2B dispatch helpers", () => {
  test("computes public port host from sandbox domain shapes", () => {
    const bareDomain: E2BSandboxInfo = {
      sandboxID: "sbx123",
      templateID: "tpl",
      domain: "e2b.app",
    };
    const sandboxDomain: E2BSandboxInfo = {
      sandboxID: "sbx123",
      templateID: "tpl",
      domain: "sbx123.e2b.app",
    };

    expect(sandboxPortHost(bareDomain, 3013)).toBe("3013-sbx123.e2b.app");
    expect(sandboxPortHost(sandboxDomain, 3013)).toBe("3013-sbx123.e2b.app");
  });

  test("computes public port host from configured E2B endpoints when API domain is absent", () => {
    const missingDomain: E2BSandboxInfo = {
      sandboxID: "sbx123",
      templateID: "tpl",
      domain: null,
    };

    expect(sandboxPortHost(missingDomain, 3013, { E2B_DOMAIN: "self-hosted.e2b.test" })).toBe(
      "3013-sbx123.self-hosted.e2b.test",
    );
    expect(
      sandboxPortHost(missingDomain, 3013, {
        E2B_SANDBOX_URL: "https://sandbox.private.e2b.test",
      }),
    ).toBe("3013-sbx123.private.e2b.test");
    expect(
      sandboxPortHost(missingDomain, 3013, {
        E2B_SANDBOX_URL: "https://sandboxes.internal:8443",
      }),
    ).toBe("3013-sbx123.sandboxes.internal:8443");
  });

  test("buildDetachedShell backgrounds command and captures pid without invalid shell chaining", () => {
    const shell = buildDetachedShell("/api-entrypoint.sh", "/tmp/api.log", "/tmp/api.pid");

    expect(shell).toContain("nohup /api-entrypoint.sh >/tmp/api.log 2>&1 </dev/null & pid=$!");
    expect(shell).toContain("sleep 2");
    expect(shell).toContain('kill -0 "$pid"');
    expect(shell).toContain("cat /tmp/api.log >&2");
    expect(shell).toContain("pid=$!");
    expect(shell).not.toContain("&;");
    expect(shell).not.toContain("& &&");
  });

  test("E2B SDK connection options preserve loaded controller endpoints", () => {
    expect(
      e2bSdkConnectionOptions(
        "controller-key",
        {
          E2B_ACCESS_TOKEN: "controller-access-token",
          E2B_DOMAIN: "sandbox.example.com",
          E2B_SANDBOX_URL: "https://sandbox.sandbox.example.com",
        },
        "https://api.sandbox.example.com",
      ),
    ).toEqual({
      apiKey: "controller-key",
      accessToken: "controller-access-token",
      domain: "sandbox.example.com",
      sandboxUrl: "https://sandbox.sandbox.example.com",
      apiUrl: "https://api.sandbox.example.com",
    });
  });

  test("waitForAgentRegistration checks the worker registration endpoint with bearer auth", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; authorization: string | null }> = [];

    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      await waitForAgentRegistration("https://api.example.com/", "worker/id", "swarm-secret", 10);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toEqual([
      {
        url: "https://api.example.com/api/agents/worker%2Fid",
        authorization: "Bearer swarm-secret",
      },
    ]);
  });

  test("buildTemplateArgs uses current Dockerfile template create command", () => {
    expect(
      buildTemplateArgs({
        role: "worker",
        name: "agent-swarm-worker",
        dockerfile: "Dockerfile.worker",
        cwd: "/repo",
        cpuCount: 4,
        memoryMb: 8192,
        noCache: true,
        e2bEnv: { E2B_API_KEY: "secret" },
      }),
    ).toEqual([
      "template",
      "create",
      "-p",
      "/repo",
      "-d",
      "Dockerfile.worker",
      "-c",
      "sleep infinity",
      "--ready-cmd",
      "sleep 0",
      "--cpu-count",
      "4",
      "--memory-mb",
      "8192",
      "--no-cache",
      "agent-swarm-worker",
    ]);
  });

  test("deleteTemplate supports dry-run cleanup", async () => {
    await expect(
      deleteTemplate({
        name: "agent-swarm-worker-e2e",
        e2bEnv: { E2B_API_KEY: "secret" },
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "e2b template delete agent-swarm-worker-e2e -y\n",
    });
  });

  test("setTemplateVisibility supports dry-run publish and unpublish", async () => {
    await expect(
      setTemplateVisibility({
        name: "agent-swarm-worker-latest",
        public: true,
        e2bEnv: { E2B_API_KEY: "secret", E2B_ACCESS_TOKEN: "secret" },
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "e2b template publish agent-swarm-worker-latest -y\n",
    });

    await expect(
      setTemplateVisibility({
        name: "agent-swarm-worker-latest",
        public: false,
        e2bEnv: { E2B_API_KEY: "secret", E2B_ACCESS_TOKEN: "secret" },
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "e2b template unpublish agent-swarm-worker-latest -y\n",
    });
  });

  test("buildImageTemplate dry-run uses the Dockerless SDK path", async () => {
    await expect(
      buildImageTemplate({
        role: "api",
        name: "agent-swarm-api",
        image: "ghcr.io/desplega-ai/agent-swarm:latest",
        cpuCount: 2,
        memoryMb: 2048,
        noCache: false,
        e2bEnv: { E2B_API_KEY: "secret" },
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining(
        "e2b-sdk template build --from-image ghcr.io/desplega-ai/agent-swarm:latest",
      ),
    });
  });
});
