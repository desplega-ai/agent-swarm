import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _getInstallationIdForTests,
  _resetTelemetryStateForTests,
  _resolveCloudMode,
  initTelemetry,
  track,
} from "../telemetry";

// initTelemetry no-ops when ANONYMIZED_TELEMETRY=false. The CI env or local
// setup may set this, so force-enable for the duration of this file.
process.env.ANONYMIZED_TELEMETRY = "true";

describe("initTelemetry", () => {
  beforeEach(() => {
    _resetTelemetryStateForTests();
    // Tests below set MCP_BASE_URL to assert classification — clear between
    // tests so cases that expect "unset" don't inherit a prior test's value.
    delete process.env.MCP_BASE_URL;
  });

  test("without generateIfMissing + missing config → installationId stays null (track no-ops)", async () => {
    const writes: Array<{ key: string; value: string }> = [];
    await initTelemetry(
      "worker",
      async () => undefined,
      async (key, value) => {
        writes.push({ key, value });
      },
    );
    expect(_getInstallationIdForTests()).toBeNull();
    expect(writes).toEqual([]);
  });

  test("without generateIfMissing + getConfig throws → installationId stays null", async () => {
    const writes: Array<{ key: string; value: string }> = [];
    await initTelemetry(
      "worker",
      async () => {
        throw new Error("network blip");
      },
      async (key, value) => {
        writes.push({ key, value });
      },
    );
    expect(_getInstallationIdForTests()).toBeNull();
    expect(writes).toEqual([]);
  });

  test("with generateIfMissing + missing config → mints install_<hex> and persists", async () => {
    const writes: Array<{ key: string; value: string }> = [];
    await initTelemetry(
      "api-server",
      async () => undefined,
      async (key, value) => {
        writes.push({ key, value });
      },
      { generateIfMissing: true },
    );
    const id = _getInstallationIdForTests();
    expect(id).not.toBeNull();
    expect(id).toMatch(/^install_[0-9a-f]{16}$/);
    expect(writes).toEqual([{ key: "telemetry_installation_id", value: id as string }]);
  });

  test("with generateIfMissing + getConfig throws → mints ephemeral_<hex>, no persist", async () => {
    const writes: Array<{ key: string; value: string }> = [];
    await initTelemetry(
      "api-server",
      async () => {
        throw new Error("db unavailable");
      },
      async (key, value) => {
        writes.push({ key, value });
      },
      { generateIfMissing: true },
    );
    const id = _getInstallationIdForTests();
    expect(id).not.toBeNull();
    expect(id).toMatch(/^ephemeral_[0-9a-f]{16}$/);
    expect(writes).toEqual([]);
  });

  describe("track() org identity in metadata", () => {
    const originalFetch = globalThis.fetch;
    let captured: Record<string, unknown> | null = null;

    beforeEach(() => {
      captured = null;
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        captured = init?.body ? JSON.parse(init.body) : null;
        return new Response(null, { status: 204 });
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env.SWARM_ORG_ID;
      delete process.env.SWARM_ORG_NAME;
      delete process.env.SWARM_CLOUD;
    });

    test("omits organization_* keys from metadata when SWARM_ORG_* unset", async () => {
      delete process.env.SWARM_ORG_ID;
      delete process.env.SWARM_ORG_NAME;
      await initTelemetry(
        "api-server",
        async () => undefined,
        async () => {},
        {
          generateIfMissing: true,
        },
      );

      track({ event: "test.event", properties: {} });
      // Wait one microtask for the fire-and-forget fetch.
      await new Promise((r) => setTimeout(r, 0));

      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.organization_id).toBeUndefined();
      expect(metadata.organization_name).toBeUndefined();
    });

    test("includes organization_id + organization_name when SWARM_ORG_* set", async () => {
      process.env.SWARM_ORG_ID = "org_acme_123";
      process.env.SWARM_ORG_NAME = "Acme Engineering";
      await initTelemetry(
        "api-server",
        async () => undefined,
        async () => {},
        {
          generateIfMissing: true,
        },
      );

      track({ event: "test.event", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.organization_id).toBe("org_acme_123");
      expect(metadata.organization_name).toBe("Acme Engineering");
    });

    test("metadata.is_cloud === false when SWARM_CLOUD unset", async () => {
      delete process.env.SWARM_CLOUD;
      await initTelemetry(
        "api-server",
        async () => undefined,
        async () => {},
        {
          generateIfMissing: true,
        },
      );

      track({ event: "test.event", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.is_cloud).toBe(false);
    });

    test("metadata.is_cloud === true when SWARM_CLOUD=true", async () => {
      process.env.SWARM_CLOUD = "true";
      await initTelemetry(
        "api-server",
        async () => undefined,
        async () => {},
        {
          generateIfMissing: true,
        },
      );

      track({ event: "test.event", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.is_cloud).toBe(true);
    });

    test("metadata.is_cloud === true when SWARM_CLOUD=1 (mirrors buildIdentity)", async () => {
      process.env.SWARM_CLOUD = "1";
      await initTelemetry(
        "api-server",
        async () => undefined,
        async () => {},
        {
          generateIfMissing: true,
        },
      );

      track({ event: "test.event", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.is_cloud).toBe(true);
    });

    test("includes only the keys that are set (org_id alone)", async () => {
      process.env.SWARM_ORG_ID = "org_solo";
      delete process.env.SWARM_ORG_NAME;
      await initTelemetry(
        "api-server",
        async () => undefined,
        async () => {},
        {
          generateIfMissing: true,
        },
      );

      track({ event: "test.event", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.organization_id).toBe("org_solo");
      expect(metadata.organization_name).toBeUndefined();
    });
  });

  test("existing config → reuses regardless of generateIfMissing flag", async () => {
    const existing = "install_deadbeefcafebabe";

    // Without flag.
    const writesA: Array<{ key: string; value: string }> = [];
    await initTelemetry(
      "worker",
      async () => existing,
      async (key, value) => {
        writesA.push({ key, value });
      },
    );
    expect(_getInstallationIdForTests()).toBe(existing);
    expect(writesA).toEqual([]);

    // With flag.
    _resetTelemetryStateForTests();
    const writesB: Array<{ key: string; value: string }> = [];
    await initTelemetry(
      "api-server",
      async () => existing,
      async (key, value) => {
        writesB.push({ key, value });
      },
      { generateIfMissing: true },
    );
    expect(_getInstallationIdForTests()).toBe(existing);
    expect(writesB).toEqual([]);
  });

  describe("_resolveCloudMode (URL → is_cloud)", () => {
    test("cloud apex host → cloud=true", () => {
      expect(_resolveCloudMode("https://agent-swarm-mcp.desplega.sh")).toEqual({ isCloud: true });
      expect(_resolveCloudMode("https://api.agent-swarm.dev")).toEqual({ isCloud: true });
      expect(_resolveCloudMode("https://agent-swarm.dev")).toEqual({ isCloud: true });
      // Future cloud subdomains (suffix match)
      expect(_resolveCloudMode("https://mcp.agent-swarm.dev/")).toEqual({ isCloud: true });
      // Trailing path / port / auth must not change the host classification
      expect(_resolveCloudMode("https://user:tok@api.agent-swarm.dev:443/api/foo?x=1")).toEqual({
        isCloud: true,
      });
      // Case-insensitive
      expect(_resolveCloudMode("https://API.Agent-Swarm.DEV")).toEqual({ isCloud: true });
    });

    test("agent-swarm.cloud apex host → cloud=true", () => {
      // Exact apex
      expect(_resolveCloudMode("https://agent-swarm.cloud")).toEqual({ isCloud: true });
      // Suffix subdomain
      expect(_resolveCloudMode("https://api.agent-swarm.cloud")).toEqual({ isCloud: true });
      expect(_resolveCloudMode("https://mcp.agent-swarm.cloud/")).toEqual({ isCloud: true });
      // Trailing path / port / auth must not change classification
      expect(_resolveCloudMode("https://user:tok@api.agent-swarm.cloud:443/api/foo?x=1")).toEqual({
        isCloud: true,
      });
      // Case-insensitive
      expect(_resolveCloudMode("https://API.Agent-Swarm.CLOUD")).toEqual({ isCloud: true });
    });

    test("self-hosted hosts → cloud=false", () => {
      expect(_resolveCloudMode("http://localhost:3013")).toEqual({ isCloud: false });
      expect(_resolveCloudMode("https://my-internal-mcp.example.com")).toEqual({ isCloud: false });
      // Substring trap — must NOT be treated as cloud
      expect(_resolveCloudMode("https://agent-swarm.dev.attacker.com")).toEqual({ isCloud: false });
      expect(_resolveCloudMode("https://agent-swarm.cloud.attacker.com")).toEqual({
        isCloud: false,
      });
      // IPv4 self-host
      expect(_resolveCloudMode("http://127.0.0.1:3013")).toEqual({ isCloud: false });
    });

    test("bare hostname / unset / weird scheme → safe fallback", () => {
      // Bare hostname (no scheme) — URL constructor throws
      expect(_resolveCloudMode("agent-swarm-mcp.desplega.sh")).toEqual({ isCloud: false });
      // Empty / undefined / null
      expect(_resolveCloudMode(undefined)).toEqual({ isCloud: false });
      expect(_resolveCloudMode(null)).toEqual({ isCloud: false });
      expect(_resolveCloudMode("")).toEqual({ isCloud: false });
      // Obvious garbage
      expect(_resolveCloudMode("not a url")).toEqual({ isCloud: false });
      // Weird scheme with no host component
      expect(_resolveCloudMode("file:///tmp/foo")).toEqual({ isCloud: false });
    });
  });

  describe("track() ships is_cloud in properties", () => {
    const originalFetch = globalThis.fetch;
    let captured: Record<string, unknown> | null = null;

    beforeEach(() => {
      captured = null;
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        captured = init?.body ? JSON.parse(init.body) : null;
        return new Response(null, { status: 204 });
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env.MCP_BASE_URL;
    });

    test("cloud MCP_BASE_URL → properties.is_cloud=true", async () => {
      process.env.MCP_BASE_URL = "https://agent-swarm-mcp.desplega.sh";
      await initTelemetry(
        "worker",
        async () => "install_cloud_test",
        async () => {},
      );

      track({ event: "server.started", properties: { port: 3013 } });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      expect(properties.is_cloud).toBe(true);
      // Hostname must NOT be emitted — telemetry is anonymous.
      expect(properties.mcp_host).toBeUndefined();
      // Caller's properties preserved alongside the cohort signal.
      expect(properties.port).toBe(3013);
    });

    test("self-hosted MCP_BASE_URL → properties.is_cloud=false", async () => {
      process.env.MCP_BASE_URL = "http://localhost:3013";
      await initTelemetry(
        "worker",
        async () => "install_self_test",
        async () => {},
      );

      track({ event: "test.event", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      expect(properties.is_cloud).toBe(false);
      expect(properties.mcp_host).toBeUndefined();
    });

    test("missing MCP_BASE_URL → safe fallback (false)", async () => {
      delete process.env.MCP_BASE_URL;
      await initTelemetry(
        "api-server",
        async () => "install_no_url",
        async () => {},
      );

      track({ event: "test.event", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      expect(properties.is_cloud).toBe(false);
      expect(properties.mcp_host).toBeUndefined();
    });

    test("caller properties cannot override is_cloud", async () => {
      // Defense-in-depth: even if a caller passes through user-supplied
      // values, the cohort signal shipped on every event must come from
      // initTelemetry — not from arbitrary call sites.
      process.env.MCP_BASE_URL = "https://agent-swarm-mcp.desplega.sh";
      await initTelemetry(
        "worker",
        async () => "install_override_test",
        async () => {},
      );

      track({
        event: "test.event",
        properties: { is_cloud: false },
      });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      expect(properties.is_cloud).toBe(true);
    });
  });
});
