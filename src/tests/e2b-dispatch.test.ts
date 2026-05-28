import { describe, expect, test } from "bun:test";
import {
  buildDetachedShell,
  buildImageTemplate,
  buildTemplateArgs,
  deleteTemplate,
  type E2BSandboxInfo,
  sandboxPortHost,
  setTemplateVisibility,
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
      `),
    ).toEqual({
      API_KEY: "abc123",
      QUOTED: "hello\nworld",
      SINGLE: "literal value",
      INLINE: "value",
    });
  });

  test("validates KEY=VALUE inputs", () => {
    expect(parseKeyValue("FOO=bar=baz", "--secret")).toEqual(["FOO", "bar=baz"]);
    expect(() => parseKeyValue("bad-key=value", "--secret")).toThrow("invalid env key");
    expect(() => parseKeyValue("NOVALUE", "--secret")).toThrow("KEY=VALUE");
  });

  test("resolves swarm API key with env-file precedence before process default", () => {
    expect(resolveSwarmApiKey({ API_KEY: "legacy", AGENT_SWARM_API_KEY: "preferred" })).toBe(
      "preferred",
    );
    expect(resolveSwarmApiKey({ API_KEY: "legacy" }, "explicit")).toBe("explicit");
    expect(resolveSwarmApiKey({})).toBe("123123");
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

  test("buildDetachedShell backgrounds command and captures pid without invalid shell chaining", () => {
    const shell = buildDetachedShell("/api-entrypoint.sh", "/tmp/api.log", "/tmp/api.pid");

    expect(shell).toContain("nohup /api-entrypoint.sh >/tmp/api.log 2>&1 </dev/null & pid=$!");
    expect(shell).toContain("pid=$!");
    expect(shell).not.toContain("&;");
    expect(shell).not.toContain("& &&");
  });

  test("buildTemplateArgs keeps local-checkout templates inert and supports build args", () => {
    expect(
      buildTemplateArgs({
        role: "worker",
        name: "agent-swarm-worker",
        dockerfile: "Dockerfile.worker",
        cwd: "/repo",
        cpuCount: 4,
        memoryMb: 8192,
        noCache: true,
        buildArgs: { CUSTOM_BUILD: "1" },
        e2bEnv: { E2B_API_KEY: "secret" },
        configPath: "/tmp/agent-swarm-worker.e2b.toml",
      }),
    ).toEqual([
      "template",
      "build",
      "-p",
      "/repo",
      "-d",
      "Dockerfile.worker",
      "-n",
      "agent-swarm-worker",
      "-c",
      "sleep infinity",
      "--ready-cmd",
      "sleep 0",
      "--cpu-count",
      "4",
      "--memory-mb",
      "8192",
      "--config",
      "/tmp/agent-swarm-worker.e2b.toml",
      "--build-arg",
      "CUSTOM_BUILD=1",
      "--no-cache",
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
