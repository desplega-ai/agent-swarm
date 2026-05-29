import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LaunchSpec, loadRuntimeEnv, parseFlags } from "../commands/e2b";
import {
  buildDetachedShell,
  buildImageTemplate,
  buildTemplateArgs,
  deleteTemplate,
  type E2BSandboxInfo,
  e2bSdkConnectionOptions,
  sandboxPortHost,
  setTemplateVisibility,
  ttlRemaining,
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

  test("ttlRemaining reads authoritative endAt when present", () => {
    const expiresAt = new Date(Date.now() + 1800 * 1000).toISOString();
    const sandbox: E2BSandboxInfo = {
      sandboxID: "sbx123",
      templateID: "tpl",
      endAt: expiresAt,
    };

    const ttl = ttlRemaining(sandbox);
    expect(ttl.expiresAt).toBe(expiresAt);
    // ~1800s remaining; allow a small window for wall-clock drift during the test.
    expect(ttl.secondsLeft).toBeGreaterThan(1790);
    expect(ttl.secondsLeft).toBeLessThanOrEqual(1800);
  });

  test("ttlRemaining falls back to client-side expiresAt and prefers endAt over it", () => {
    const fallback = new Date(Date.now() + 600 * 1000).toISOString();
    const fallbackOnly: E2BSandboxInfo = {
      sandboxID: "sbx456",
      templateID: "tpl",
      expiresAt: fallback,
    };
    const fallbackTtl = ttlRemaining(fallbackOnly);
    expect(fallbackTtl.expiresAt).toBe(fallback);
    expect(fallbackTtl.secondsLeft).toBeGreaterThan(590);
    expect(fallbackTtl.secondsLeft).toBeLessThanOrEqual(600);

    // endAt is authoritative and wins over the client-side fallback.
    const authoritative = new Date(Date.now() + 3600 * 1000).toISOString();
    const both = ttlRemaining({ ...fallbackOnly, endAt: authoritative });
    expect(both.expiresAt).toBe(authoritative);
    expect(both.secondsLeft).toBeGreaterThan(3590);
  });

  test("ttlRemaining returns empty for absent endAt/expiresAt and clamps expired to zero", () => {
    expect(ttlRemaining({ sandboxID: "none", templateID: "tpl" })).toEqual({});
    const expired = ttlRemaining({
      sandboxID: "old",
      templateID: "tpl",
      endAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    expect(expired.secondsLeft).toBe(0);
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
          E2B_DOMAIN: "sandbox.example.com",
          E2B_SANDBOX_URL: "https://sandbox.sandbox.example.com",
        },
        "https://api.sandbox.example.com",
      ),
    ).toEqual({
      apiKey: "controller-key",
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
        e2bEnv: { E2B_API_KEY: "secret" },
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'PATCH /v2/templates/agent-swarm-worker-latest {"public":true}\n',
    });

    await expect(
      setTemplateVisibility({
        name: "agent-swarm-worker-latest",
        public: false,
        e2bEnv: { E2B_API_KEY: "secret" },
        dryRun: true,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'PATCH /v2/templates/agent-swarm-worker-latest {"public":false}\n',
    });
  });

  test("setTemplateVisibility updates templates through the E2B API key path", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ names: ["workspace/agent-swarm-worker-latest"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const result = await setTemplateVisibility({
        name: "agent swarm/worker",
        public: true,
        e2bEnv: {
          E2B_API_KEY: "controller-secret",
          E2B_API_URL: "https://api.e2b.example",
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://api.e2b.example/v2/templates/agent%20swarm%2Fworker");
      expect(calls[0]?.init?.method).toBe("PATCH");
      expect(calls[0]?.init?.headers).toMatchObject({
        "Content-Type": "application/json",
        "X-API-Key": "controller-secret",
      });
      expect(calls[0]?.init?.body).toBe(JSON.stringify({ public: true }));
      expect(result.stdout).toBe(
        "Set E2B template agent swarm/worker visibility to public (workspace/agent-swarm-worker-latest)\n",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
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

describe("E2B namespaced env scoping", () => {
  const API_SPEC: LaunchSpec = { swarmRole: "api", envScope: "api" };
  const LEAD_SPEC: LaunchSpec = { swarmRole: "worker", agentRole: "lead", envScope: "lead" };
  const WORKER_SPEC: LaunchSpec = { swarmRole: "worker", agentRole: "worker", envScope: "worker" };
  // A dummy MCP base URL — loadRuntimeEnv requires one for non-api roles.
  const API_URL = "https://api.example.com";

  // Phase 2 layering is precedence-only; --dry-run keeps the swarm-API-key
  // resolution from throwing without touching E2B. We snapshot/restore the
  // forward-key env vars so ambient values can't leak into the assertions.
  const previous: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ["AGENT_SWARM_API_KEY", "API_KEY", "HARNESS_PROVIDER"]) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function resolveAllScopes(argv: string[]) {
    const flags = parseFlags(["start-stack", ...argv, "--dry-run"]);
    const [api, lead, worker] = await Promise.all([
      loadRuntimeEnv(flags, API_SPEC),
      loadRuntimeEnv(flags, LEAD_SPEC, API_URL),
      loadRuntimeEnv(flags, WORKER_SPEC, API_URL),
    ]);
    return { api, lead, worker };
  }

  test("--worker-secret lands only in the worker scope", async () => {
    const { api, lead, worker } = await resolveAllScopes(["--worker-secret", "FOO=x"]);
    expect(worker.FOO).toBe("x");
    expect(lead.FOO).toBeUndefined();
    expect(api.FOO).toBeUndefined();
  });

  test("--lead-secret lands only in the lead scope", async () => {
    const { api, lead, worker } = await resolveAllScopes(["--lead-secret", "K=v"]);
    expect(lead.K).toBe("v");
    expect(worker.K).toBeUndefined();
    expect(api.K).toBeUndefined();
  });

  test("--api-secret lands only in the api scope", async () => {
    const { api, lead, worker } = await resolveAllScopes(["--api-secret", "ZED=q"]);
    expect(api.ZED).toBe("q");
    expect(lead.ZED).toBeUndefined();
    expect(worker.ZED).toBeUndefined();
  });

  test("shared --secret applies to all three scopes", async () => {
    const { api, lead, worker } = await resolveAllScopes(["--secret", "BAR=y"]);
    expect(api.BAR).toBe("y");
    expect(lead.BAR).toBe("y");
    expect(worker.BAR).toBe("y");
  });

  test("scoped --secret layers on top of the shared --secret without replacing it", async () => {
    // Shared sets SHARED + OVERRIDE; worker scope overrides OVERRIDE and adds
    // WORKER_ONLY. The shared value must survive in the non-overridden scopes.
    const { api, lead, worker } = await resolveAllScopes([
      "--secret",
      "SHARED=shared",
      "--secret",
      "OVERRIDE=shared-val",
      "--worker-secret",
      "OVERRIDE=worker-val",
      "--worker-secret",
      "WORKER_ONLY=w",
    ]);

    expect(api.SHARED).toBe("shared");
    expect(lead.SHARED).toBe("shared");
    expect(worker.SHARED).toBe("shared");

    expect(worker.OVERRIDE).toBe("worker-val");
    expect(lead.OVERRIDE).toBe("shared-val");
    expect(api.OVERRIDE).toBe("shared-val");

    expect(worker.WORKER_ONLY).toBe("w");
    expect(lead.WORKER_ONLY).toBeUndefined();
    expect(api.WORKER_ONLY).toBeUndefined();
  });

  test("scoped --{scope}-env-file layers over the shared --env-file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2b-env-scope-"));
    const sharedFile = join(dir, "shared.env");
    const workerFile = join(dir, "worker.env");
    writeFileSync(sharedFile, "SHARED_FILE=base\nFROM_SHARED=keep\n");
    writeFileSync(workerFile, "SHARED_FILE=override\nWORKER_FILE_ONLY=w\n");

    const { api, lead, worker } = await resolveAllScopes([
      "--env-file",
      sharedFile,
      "--worker-env-file",
      workerFile,
    ]);

    // Shared file is visible everywhere.
    expect(api.FROM_SHARED).toBe("keep");
    expect(lead.FROM_SHARED).toBe("keep");
    expect(worker.FROM_SHARED).toBe("keep");

    // Worker-scoped file overrides the shared value only in the worker scope.
    expect(worker.SHARED_FILE).toBe("override");
    expect(lead.SHARED_FILE).toBe("base");
    expect(api.SHARED_FILE).toBe("base");

    // Worker-only key never bleeds into the other scopes.
    expect(worker.WORKER_FILE_ONLY).toBe("w");
    expect(lead.WORKER_FILE_ONLY).toBeUndefined();
    expect(api.WORKER_FILE_ONLY).toBeUndefined();
  });

  test("scoped --secret wins over both shared and scoped env-files (precedence order)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2b-env-prec-"));
    const sharedFile = join(dir, "shared.env");
    const workerFile = join(dir, "worker.env");
    writeFileSync(sharedFile, "PREC=from-shared-file\n");
    writeFileSync(workerFile, "PREC=from-worker-file\n");

    const { worker } = await resolveAllScopes([
      "--env-file",
      sharedFile,
      "--worker-env-file",
      workerFile,
      "--secret",
      "PREC=from-shared-secret",
      "--worker-secret",
      "PREC=from-worker-secret",
    ]);

    // Highest-precedence non-forced layer wins.
    expect(worker.PREC).toBe("from-worker-secret");
  });

  test("AGENT_ROLE comes from the spec; lead spec yields AGENT_ROLE=lead", async () => {
    const { lead, worker } = await resolveAllScopes([]);
    expect(lead.AGENT_ROLE).toBe("lead");
    expect(worker.AGENT_ROLE).toBe("worker");
  });

  test("worker spec without an agentRole falls back to the global --agent-role", async () => {
    // start-worker stays identical: WORKER_SPEC carries agentRole:"worker" only
    // in start-stack; the legacy path uses a spec with no agentRole and relies
    // on --agent-role. Mirror that here with an agentRole-less worker spec.
    const flags = parseFlags(["start-worker", "--agent-role", "lead", "--dry-run"]);
    const legacyWorkerSpec: LaunchSpec = { swarmRole: "worker", envScope: "worker" };
    const env = await loadRuntimeEnv(flags, legacyWorkerSpec, API_URL);
    expect(env.AGENT_ROLE).toBe("lead");
  });

  test("forced API_KEY/AGENT_SWARM_API_KEY win over a user --secret API_KEY", async () => {
    // A user must not be able to break swarm auth by overriding API_KEY via a
    // scoped or shared secret — the forced resolution always applies last.
    const flags = parseFlags([
      "start-api",
      "--api-key",
      "forced-key",
      "--secret",
      "API_KEY=attacker",
      "--dry-run",
    ]);
    const env = await loadRuntimeEnv(flags, API_SPEC);
    expect(env.API_KEY).toBe("forced-key");
    expect(env.AGENT_SWARM_API_KEY).toBe("forced-key");
  });
});
