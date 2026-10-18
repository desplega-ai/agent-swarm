import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applyResolvedEnvToProcessEnv, withHarnessTelemetryEnv } from "../commands/runner";
import { _resetTelemetryStateForTests, initTelemetry, track } from "../telemetry";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

const TELEMETRY_PATH = join(import.meta.dir, "..", "telemetry.ts");

// Stands in for an API an agent boots from its shell: initialize telemetry the
// way the API server does, send one event through a mocked fetch (nothing
// leaves the process), and print the environment the event carries.
const BOOT_SCRIPT = `
const t = await import(${JSON.stringify(TELEMETRY_PATH)});
let body;
globalThis.fetch = async (_url, init) => {
  body = JSON.parse(init.body);
  return new Response(null, { status: 204 });
};
await t.initTelemetry(
  "api-server",
  async (key) => (key === "telemetry_installation_id" ? "install_boot_repro" : undefined),
  async () => {},
  { generateIfMissing: true },
);
t.track({ event: "test.event", properties: {} });
await new Promise((r) => setTimeout(r, 0));
console.log("ENV=" + (body?.metadata?.environment ?? "none"));
`;

/** A deployment env with no telemetry cohort chosen: no tag, no NODE_ENV. */
function untaggedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ANONYMIZED_TELEMETRY: "true",
    SWARM_ORG_NAME: "desplega labs",
  };
  delete env.DESPLEGA_TELEMETRY_ENV;
  delete env.NODE_ENV;
  return env;
}

async function bootEnvironment(env: Record<string, string | undefined>): Promise<string> {
  const result = await runChild([process.execPath, "-e", BOOT_SCRIPT], { env });
  expect(result.stderr).not.toContain("error:");
  expect(result.exitCode).toBe(0);
  return result.stdout.match(/^ENV=(.*)$/m)?.[1] ?? "";
}

describe("withHarnessTelemetryEnv", () => {
  test("defaults the harness session env to test when the key is unset", () => {
    const env = withHarnessTelemetryEnv({ PATH: "/usr/bin" });
    expect(env.DESPLEGA_TELEMETRY_ENV).toBe("test");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("treats a blank value as unset", () => {
    expect(withHarnessTelemetryEnv({ DESPLEGA_TELEMETRY_ENV: "  " }).DESPLEGA_TELEMETRY_ENV).toBe(
      "test",
    );
  });

  test("keeps an explicit value", () => {
    expect(
      withHarnessTelemetryEnv({ DESPLEGA_TELEMETRY_ENV: "production" }).DESPLEGA_TELEMETRY_ENV,
    ).toBe("production");
  });

  test("returns a copy and leaves the runner's env untouched", () => {
    const original = process.env.DESPLEGA_TELEMETRY_ENV;
    delete process.env.DESPLEGA_TELEMETRY_ENV;
    try {
      const resolved: Record<string, string | undefined> = { ...process.env };
      const sessionEnv = withHarnessTelemetryEnv(resolved);
      expect(sessionEnv).not.toBe(resolved);
      expect(sessionEnv.DESPLEGA_TELEMETRY_ENV).toBe("test");
      expect(resolved.DESPLEGA_TELEMETRY_ENV).toBeUndefined();
      expect(process.env.DESPLEGA_TELEMETRY_ENV).toBeUndefined();

      // Even handed process.env itself, it must not write back.
      const direct = withHarnessTelemetryEnv(process.env);
      expect(direct).not.toBe(process.env);
      expect(process.env.DESPLEGA_TELEMETRY_ENV).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.DESPLEGA_TELEMETRY_ENV;
      else process.env.DESPLEGA_TELEMETRY_ENV = original;
    }
  });
});

test("worker telemetry receives and clears company profile through resolved config", async () => {
  const profile = {
    SWARM_ORG_WEBSITE: "acme.com",
    SWARM_ORG_TEAM_SIZE: "2-10",
    SWARM_ORG_USE_CASE: "ops",
    SWARM_ORG_ACQUISITION_SOURCE: "github",
  };
  const saved = Object.fromEntries(
    [...Object.keys(profile), "ANONYMIZED_TELEMETRY"].map((key) => [key, process.env[key]]),
  );
  const originalFetch = globalThis.fetch;
  const sent: Array<{ context: Record<string, unknown> }> = [];
  try {
    process.env.ANONYMIZED_TELEMETRY = "true";
    _resetTelemetryStateForTests();
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? "{}"));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    applyResolvedEnvToProcessEnv(profile);
    const config: Record<string, string> = {
      telemetry_installation_id: "install_worker_profile",
      telemetry_org_id: "org_0123456789abcdef",
      telemetry_org_domain: "acme.com",
    };
    await initTelemetry(
      "worker",
      (key) => config[key],
      () => {},
    );
    track({ event: "session.started", properties: { agentId: crypto.randomUUID() } });
    expect(sent[0]?.context).toMatchObject({
      org_website: "acme.com",
      org_domain: "acme.com",
      team_size: "2-10",
      use_case: "ops",
      acquisition_source: "github",
    });
    applyResolvedEnvToProcessEnv(Object.fromEntries(Object.keys(profile).map((key) => [key, ""])));
    track({ event: "session.started", properties: { agentId: crypto.randomUUID() } });
    expect(sent[1]?.context).not.toHaveProperty("org_website");
    expect(sent[1]?.context).not.toHaveProperty("team_size");
    expect(sent[1]?.context).not.toHaveProperty("use_case");
    expect(sent[1]?.context.acquisition_source).toBeNull();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = originalFetch;
    _resetTelemetryStateForTests();
  }
});

describe("API boot telemetry environment", () => {
  test(
    "an unprefixed API boot from an agent session emits test",
    async () => {
      expect(await bootEnvironment(withHarnessTelemetryEnv(untaggedEnv()))).toBe("test");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a boot with no harness env emits production",
    async () => {
      expect(await bootEnvironment(untaggedEnv())).toBe("production");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
