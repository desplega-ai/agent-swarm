import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDashboardDeepLink,
  type LaunchSpec,
  loadRuntimeEnv,
  parseFlags,
  resolveIntegrationToggles,
  runE2BCommand,
  swarmGroupMembers,
} from "../commands/e2b";
import { buildOnboardDashboardUrl } from "../commands/onboard/dashboard-url";
import {
  buildImageTemplate,
  buildTemplateArgs,
  buildTrackedShell,
  deleteTemplate,
  type E2BSandboxInfo,
  e2bSdkConnectionOptions,
  sandboxLogPath,
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

  test("buildTrackedShell pipes the entrypoint through tee to the log path (Phase 5)", () => {
    const logPath = sandboxLogPath("api");
    const shell = buildTrackedShell("/api-entrypoint.sh", logPath);

    // Phase 5: the entrypoint runs as the SDK BACKGROUND command itself (envd
    // owns/streams it), no longer a detached `nohup … &` grandchild.
    expect(logPath).toBe("/tmp/agent-swarm-e2b-api.log");
    expect(shell).toBe(
      "set -o pipefail; /api-entrypoint.sh 2>&1 | tee /tmp/agent-swarm-e2b-api.log",
    );
    // Must tee to the deterministic file so `swarms logs` can read full history.
    expect(shell).toContain(`tee ${logPath}`);
    // pipefail makes the pipeline exit reflect the entrypoint (not tee) for the
    // early-failure poll in startDetachedProcess.
    expect(shell).toContain("set -o pipefail");
    // The old detach primitives are gone.
    expect(shell).not.toContain("nohup");
    expect(shell).not.toContain("kill -0");
    expect(shell).not.toContain("sleep 2");
  });

  test("sandboxLogPath is deterministic per E2B role", () => {
    expect(sandboxLogPath("api")).toBe("/tmp/agent-swarm-e2b-api.log");
    expect(sandboxLogPath("worker")).toBe("/tmp/agent-swarm-e2b-worker.log");
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

describe("E2B start-stack topology (Phase 3)", () => {
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

  /** Run `e2b <argv>` capturing stdout, then parse the JSON it printed. */
  async function runStackJson(argv: string[]): Promise<Record<string, unknown>> {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    const previousExitCode = process.exitCode;
    try {
      await runE2BCommand(argv);
    } finally {
      console.log = originalLog;
    }
    // A clean dry-run must not set a failure exit code.
    expect(process.exitCode ?? 0).toBe(previousExitCode ?? 0);
    // Phase 4 prepends a "swarm: <slug>" echo before the JSON; parse from the
    // first line that opens the JSON object so the preamble is skipped.
    const jsonStart = lines.findIndex((l) => l.trim().startsWith("{"));
    return JSON.parse(lines.slice(Math.max(jsonStart, 0)).join("\n")) as Record<string, unknown>;
  }

  test("dry-run stack provisions api + lead + N workers", async () => {
    const payload = await runStackJson([
      "start-stack",
      "--dry-run",
      "--yes",
      "--workers",
      "2",
      "--swarm",
      "test",
      "--json",
    ]);

    expect(payload.api).toBeDefined();
    expect(payload.lead).toBeDefined();
    expect(Array.isArray(payload.workers)).toBe(true);
    expect((payload.workers as unknown[]).length).toBe(2);
    // The lead is E2B SwarmRole "worker" with AGENT_ROLE lead.
    expect((payload.lead as { role: string }).role).toBe("worker");
    expect((payload.api as { role: string }).role).toBe("api");
  });

  test("--no-lead keeps the legacy api + workers topology (no lead key)", async () => {
    const payload = await runStackJson([
      "start-stack",
      "--dry-run",
      "--yes",
      "--no-lead",
      "--workers",
      "2",
      "--swarm",
      "test",
      "--json",
    ]);

    expect(payload.api).toBeDefined();
    expect(payload.lead).toBeUndefined();
    expect(Array.isArray(payload.workers)).toBe(true);
    expect((payload.workers as unknown[]).length).toBe(2);
  });

  test("rejects a shared explicit --agent-id across multiple workers", async () => {
    // A single explicit --agent-id reused for N>1 workers would collapse them
    // into one agent record (the API reuses the row for an existing X-Agent-ID).
    // The guard must fire before any sandbox is provisioned, even on dry-run.
    // runE2BCommand swallows the throw into a stderr line + exitCode=1, so assert
    // on those rather than on a propagated exception.
    const originalError = console.error;
    const errLines: string[] = [];
    console.error = (...args: unknown[]) => {
      errLines.push(args.map(String).join(" "));
    };
    const previousExitCode = process.exitCode;
    try {
      await runE2BCommand([
        "start-stack",
        "--dry-run",
        "--yes",
        "--workers",
        "2",
        "--swarm",
        "test",
        "--agent-id",
        "fixed-worker",
        "--json",
      ]);
    } finally {
      console.error = originalError;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode ?? 0;
    expect(errLines.join("\n")).toContain("--agent-id cannot be shared across multiple workers");
  });

  test("allows an explicit --agent-id for a single-worker stack", async () => {
    // One worker + explicit ID is unambiguous — no collision, so it must pass.
    const payload = await runStackJson([
      "start-stack",
      "--dry-run",
      "--yes",
      "--workers",
      "1",
      "--swarm",
      "test",
      "--agent-id",
      "fixed-worker",
      "--json",
    ]);
    expect((payload.workers as unknown[]).length).toBe(1);
  });

  test("integration toggles disable only the unlisted/--no-<x> integrations", () => {
    // Default: all on.
    expect(resolveIntegrationToggles(parseFlags(["start-stack"]))).toEqual({
      slack: true,
      github: true,
      jira: true,
      linear: true,
    });
    // --no-slack flips just slack off.
    expect(resolveIntegrationToggles(parseFlags(["start-stack", "--no-slack"]))).toMatchObject({
      slack: false,
      github: true,
    });
    // --integrations is an allowlist: only github stays on.
    expect(
      resolveIntegrationToggles(parseFlags(["start-stack", "--integrations", "github"])),
    ).toEqual({
      slack: false,
      github: true,
      jira: false,
      linear: false,
    });
  });

  test("integration disables land only on the API runtime scope", async () => {
    const flags = parseFlags([
      "start-stack",
      "--no-slack",
      "--integrations",
      "github",
      "--dry-run",
      "--api-key",
      "k",
    ]);
    const api = await loadRuntimeEnv(flags, { swarmRole: "api", envScope: "api" });
    const worker = await loadRuntimeEnv(
      flags,
      { swarmRole: "worker", agentRole: "worker", envScope: "worker" },
      "https://api.example.com",
    );

    expect(api.SLACK_DISABLE).toBe("true");
    expect(api.JIRA_DISABLE).toBe("true");
    expect(api.LINEAR_DISABLE).toBe("true");
    // github stayed on via the allowlist.
    expect(api.GITHUB_DISABLE).toBeUndefined();
    // The worker scope never carries these API-side toggles.
    expect(worker.SLACK_DISABLE).toBeUndefined();
  });
});

describe("E2B swarm grouping + deep-link (Phase 4)", () => {
  const previous: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ["AGENT_SWARM_API_KEY", "API_KEY", "HARNESS_PROVIDER", "APP_URL"]) {
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

  /** Run `e2b <argv>` capturing stdout lines (no JSON parse). */
  async function runStackLines(argv: string[]): Promise<string[]> {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await runE2BCommand(argv);
    } finally {
      console.log = originalLog;
    }
    return lines;
  }

  test("dry-run stack stamps swarm + swarmRole onto every sandbox's metadata", async () => {
    const lines = await runStackLines([
      "start-stack",
      "--dry-run",
      "--yes",
      "--workers",
      "1",
      "--swarm",
      "demo",
      "--json",
    ]);
    // The "swarm: demo" echo precedes the JSON; parse only the JSON tail.
    const jsonStart = lines.findIndex((l) => l.trim().startsWith("{"));
    const payload = JSON.parse(lines.slice(jsonStart).join("\n")) as {
      api: { sandbox: { metadata: Record<string, string> } };
      lead: { sandbox: { metadata: Record<string, string> } };
      workers: { sandbox: { metadata: Record<string, string> } }[];
    };

    // Shared slug across all roles.
    expect(payload.api.sandbox.metadata.swarm).toBe("demo");
    expect(payload.lead.sandbox.metadata.swarm).toBe("demo");
    expect(payload.workers[0]?.sandbox.metadata.swarm).toBe("demo");

    // Distinct grouping roles (lead is E2B role:"worker" but swarmRole:"lead").
    expect(payload.api.sandbox.metadata.swarmRole).toBe("api");
    expect(payload.lead.sandbox.metadata.swarmRole).toBe("lead");
    expect(payload.workers[0]?.sandbox.metadata.swarmRole).toBe("worker");

    // API carries its port; lead/worker do not (they carry agentId reconstruction-ready data).
    expect(payload.api.sandbox.metadata.apiPort).toBe("3013");
  });

  test("a stack with no --swarm generates a shared slug and echoes it", async () => {
    const lines = await runStackLines(["start-stack", "--dry-run", "--yes", "--workers", "1"]);
    const swarmLine = lines.find((l) => l.startsWith("swarm: "));
    expect(swarmLine).toBeDefined();
    const slug = swarmLine?.slice("swarm: ".length).trim() ?? "";
    expect(slug).toMatch(/^swarm-[0-9a-f]{6}$/);
  });

  test("e2b dashboard deep-link uses camelCase params and hides the key by default", () => {
    const masked = buildDashboardDeepLink(
      { apiUrl: "https://api.example.com", apiKey: "super-secret-key", name: "demo" },
      false,
    );
    // camelCase params the SPA reads.
    expect(masked).toContain("apiUrl=https%3A%2F%2Fapi.example.com");
    expect(masked).toContain("name=demo");
    // Key hidden — the real value MUST NOT appear.
    expect(masked).toContain("apiKey=<hidden — pass --reveal-key>");
    expect(masked).not.toContain("super-secret-key");
    // Never snake_case.
    expect(masked).not.toContain("api_url");
    expect(masked).not.toContain("api_key");
  });

  test("e2b dashboard deep-link embeds the real key only when revealed", () => {
    const revealed = buildDashboardDeepLink(
      { apiUrl: "https://api.example.com", apiKey: "super-secret-key", name: "demo" },
      true,
    );
    expect(revealed).toContain("apiKey=super-secret-key");
    expect(revealed).not.toContain("<hidden");
    expect(revealed).toContain("apiUrl=https%3A%2F%2Fapi.example.com");
  });

  test("--reveal-key gating: default masks the key in stack output, flag reveals it", async () => {
    process.env.APP_URL = "https://dash.example.com";
    const baseArgs = [
      "start-stack",
      "--dry-run",
      "--yes",
      "--workers",
      "1",
      "--api-key",
      "k3y-s3cr3t-value",
    ];

    const maskedLines = await runStackLines(baseArgs);
    const maskedDash = maskedLines.find((l) => l.startsWith("dashboard: ")) ?? "";
    expect(maskedDash).toContain("apiKey=<hidden — pass --reveal-key>");
    expect(maskedDash).not.toContain("k3y-s3cr3t-value");

    const revealedLines = await runStackLines([...baseArgs, "--reveal-key"]);
    const revealedDash = revealedLines.find((l) => l.startsWith("dashboard: ")) ?? "";
    expect(revealedDash).toContain("apiKey=k3y-s3cr3t-value");
    expect(revealedDash).not.toContain("<hidden");
  });

  test("onboarding dashboard builder emits camelCase apiUrl/apiKey (not snake_case)", () => {
    const url = buildOnboardDashboardUrl({
      apiUrl: "http://localhost:3013",
      apiKey: "onboard-key",
    });
    expect(url).toContain("apiUrl=http%3A%2F%2Flocalhost%3A3013");
    expect(url).toContain("apiKey=onboard-key");
    // The bug we fixed: snake_case is silently ignored by the SPA.
    expect(url).not.toContain("api_url");
    expect(url).not.toContain("api_key");
    expect(url.startsWith("https://app.agent-swarm.dev?")).toBe(true);
  });

  test("swarmGroupMembers restricts a named swarm to dispatcher-owned sandboxes", () => {
    const sandboxes: E2BSandboxInfo[] = [
      // Ours: matching slug + our launcher tag.
      {
        sandboxID: "ours-api",
        templateID: "tpl",
        metadata: { swarm: "myswarm", launcher: "agent-swarm-e2b", swarmRole: "api" },
      },
      {
        sandboxID: "ours-worker",
        templateID: "tpl",
        metadata: { swarm: "myswarm", launcher: "agent-swarm-e2b", swarmRole: "worker" },
      },
      // Foreign: same slug, but NOT launched by us — must be excluded so
      // `swarms kill/info/logs/add` can never touch it.
      {
        sandboxID: "foreign-collision",
        templateID: "tpl",
        metadata: { swarm: "myswarm" },
      },
      // Ours, but a different swarm — excluded by the slug filter.
      {
        sandboxID: "ours-other",
        templateID: "tpl",
        metadata: { swarm: "otherswarm", launcher: "agent-swarm-e2b" },
      },
    ];

    const members = swarmGroupMembers(sandboxes, "myswarm");
    expect(members.map((m) => m.sandboxID).sort()).toEqual(["ours-api", "ours-worker"]);
    // The foreign sandbox with a colliding generic `metadata.swarm` is dropped.
    expect(members.some((m) => m.sandboxID === "foreign-collision")).toBe(false);
  });
});
