import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pkg from "../../package.json";
import {
  _getInstallationIdForTests,
  _getInstalledAtForTests,
  _hasEmailChannel,
  _hasEmbeddingKey,
  _hasSlackChannel,
  _isE2bSandbox,
  _resetTelemetryStateForTests,
  _resolveCloudMode,
  _resolveInstallMethod,
  _resolveInstallPreset,
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
    delete process.env.DESPLEGA_TELEMETRY_ENV;
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

  test("with generateIfMissing + missing config → mints install_<hex> and persists (id + installed_at)", async () => {
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
    const installedAt = _getInstalledAtForTests();
    expect(installedAt).not.toBeNull();
    expect(writes).toEqual([
      { key: "telemetry_installation_id", value: id as string },
      { key: "telemetry_installed_at", value: installedAt as string },
    ]);
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
    // Config access is failing — nowhere durable to persist an anchor, so
    // leave it null rather than faking a fresh mint.
    expect(_getInstalledAtForTests()).toBeNull();
  });

  describe("telemetry_installed_at persistence failure-safety", () => {
    test("fresh install: telemetry_installed_at write fails → installationId still persists+resolves, installedAt stays null", async () => {
      const writes: Array<{ key: string; value: string }> = [];
      await initTelemetry(
        "api-server",
        async () => undefined,
        async (key, value) => {
          if (key === "telemetry_installed_at") {
            throw new Error("config write failed");
          }
          writes.push({ key, value });
        },
        { generateIfMissing: true },
      );
      const id = _getInstallationIdForTests();
      // Must be the real minted+persisted ID, not an ephemeral fallback — the
      // installed_at failure must not unwind and discard the installationId
      // write that already succeeded.
      expect(id).toMatch(/^install_[0-9a-f]{16}$/);
      expect(writes).toEqual([{ key: "telemetry_installation_id", value: id as string }]);
      // No fabricated/unpersisted anchor emitted this session.
      expect(_getInstalledAtForTests()).toBeNull();
    });

    test("existing installationId, no stored anchor → installedAt omitted, no backfill write attempted (even with generateIfMissing)", async () => {
      const existing = "install_noanchor";
      const writes: Array<{ key: string; value: string }> = [];
      await initTelemetry(
        "api-server",
        async (key) => (key === "telemetry_installation_id" ? existing : undefined),
        async (key, value) => {
          writes.push({ key, value });
        },
        { generateIfMissing: true },
      );
      // A pre-existing installation ID with no stored anchor must NOT mint
      // now() as a stand-in install date — that back-fills a wrong date
      // instead of an honestly-absent one. No write, no fabricated anchor.
      expect(_getInstallationIdForTests()).toBe(existing);
      expect(writes).toEqual([]);
      expect(_getInstalledAtForTests()).toBeNull();
    });

    test("already-exists: both installation_id and installed_at present → no writes, reuses existing anchor", async () => {
      const existing = "install_alreadyexists";
      const existingInstalledAt = "2026-01-01T00:00:00.000Z";
      const writes: Array<{ key: string; value: string }> = [];
      await initTelemetry(
        "api-server",
        async (key) => {
          if (key === "telemetry_installation_id") return existing;
          if (key === "telemetry_installed_at") return existingInstalledAt;
          return undefined;
        },
        async (key, value) => {
          writes.push({ key, value });
        },
        { generateIfMissing: true },
      );
      expect(_getInstallationIdForTests()).toBe(existing);
      expect(_getInstalledAtForTests()).toBe(existingInstalledAt);
      expect(writes).toEqual([]);
    });
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

  describe("_isE2bSandbox detection", () => {
    afterEach(() => {
      delete process.env.E2B_SANDBOX_ID;
    });

    test("returns true when E2B_SANDBOX_ID is set", () => {
      process.env.E2B_SANDBOX_ID = "sbx_abc123";
      expect(_isE2bSandbox()).toBe(true);
    });

    test("returns false when E2B_SANDBOX_ID is unset", () => {
      delete process.env.E2B_SANDBOX_ID;
      expect(_isE2bSandbox()).toBe(false);
    });

    test("returns false when E2B_SANDBOX_ID is empty string", () => {
      process.env.E2B_SANDBOX_ID = "";
      expect(_isE2bSandbox()).toBe(false);
    });
  });

  describe("track() ships is_e2b in properties", () => {
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
      delete process.env.E2B_SANDBOX_ID;
    });

    test("properties.is_e2b=true when E2B_SANDBOX_ID is set at init", async () => {
      process.env.E2B_SANDBOX_ID = "sbx_test123";
      await initTelemetry(
        "api-server",
        async () => "install_e2b_test",
        async () => {},
      );

      track({ event: "server.started", properties: { port: 3013 } });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      expect(properties.is_e2b).toBe(true);
      expect(properties.port).toBe(3013);
    });

    test("properties.is_e2b=false when E2B_SANDBOX_ID is unset at init", async () => {
      delete process.env.E2B_SANDBOX_ID;
      await initTelemetry(
        "api-server",
        async () => "install_no_e2b",
        async () => {},
      );

      track({ event: "test.event", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      expect(properties.is_e2b).toBe(false);
    });

    test("caller properties cannot override is_e2b", async () => {
      process.env.E2B_SANDBOX_ID = "sbx_override_test";
      await initTelemetry(
        "api-server",
        async () => "install_e2b_override",
        async () => {},
      );

      track({ event: "test.event", properties: { is_e2b: false } });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      expect(properties.is_e2b).toBe(true);
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

    test("hosted Swarm Cloud shape (intra-compose MCP_BASE_URL + SWARM_CLOUD=true) → properties.is_cloud=true", async () => {
      // Mirrors agent-swarm-internal's Hetzner compose template: MCP_BASE_URL
      // is the intra-compose service address (never a cloud hostname), and
      // SWARM_CLOUD=true is seeded via .env.personalization. The hostname
      // heuristic alone would misclassify this as self-host.
      process.env.MCP_BASE_URL = "http://api:3013";
      process.env.SWARM_CLOUD = "true";
      await initTelemetry(
        "api-server",
        async () => "install_hosted_cloud_test",
        async () => {},
      );

      track({ event: "server.started", properties: { port: 3013 } });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      expect(properties.is_cloud).toBe(true);
      expect(properties.mcp_host).toBeUndefined();

      delete process.env.SWARM_CLOUD;
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

  describe("track() ships swarmVersion in properties", () => {
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
    });

    test("includes the package version on every event and ignores caller overrides", async () => {
      await initTelemetry(
        "worker",
        async () => "install_version_test",
        async () => {},
      );

      track({ event: "test.event", properties: { swarmVersion: "spoofed" } });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      expect(properties.swarmVersion).toBe(pkg.version);
    });
  });

  describe("track() metadata.environment", () => {
    const originalFetch = globalThis.fetch;
    const originalNodeEnv = process.env.NODE_ENV;
    let captured: Record<string, unknown> | null = null;

    beforeEach(() => {
      captured = null;
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        captured = init?.body ? JSON.parse(init.body) : null;
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      delete process.env.DESPLEGA_TELEMETRY_ENV;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env.DESPLEGA_TELEMETRY_ENV;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    });

    test("defaults to production even when NODE_ENV is development", async () => {
      process.env.NODE_ENV = "development";
      await initTelemetry(
        "api-server",
        async () => "install_default_env",
        async () => {},
      );

      track({ event: "test.event", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.environment).toBe("production");
    });

    test("uses DESPLEGA_TELEMETRY_ENV when set", async () => {
      process.env.NODE_ENV = "production";
      process.env.DESPLEGA_TELEMETRY_ENV = "development";
      await initTelemetry(
        "api-server",
        async () => "install_explicit_env",
        async () => {},
      );

      track({ event: "test.event", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.environment).toBe("development");
    });

    test("preserves NODE_ENV=test when telemetry env is unset", async () => {
      process.env.NODE_ENV = "test";
      await initTelemetry(
        "api-server",
        async () => "install_test_env",
        async () => {},
      );

      track({ event: "test.event", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.environment).toBe("test");
    });
  });

  describe("_resolveInstallMethod", () => {
    test("known values pass through unchanged", () => {
      expect(_resolveInstallMethod("onboard_interactive", false)).toBe("onboard_interactive");
      expect(_resolveInstallMethod("onboard_noninteractive", false)).toBe("onboard_noninteractive");
    });

    test("known value still wins even inside an E2B sandbox", () => {
      expect(_resolveInstallMethod("onboard_interactive", true)).toBe("onboard_interactive");
    });

    test("missing/unrecognized value + E2B sandbox → e2b", () => {
      expect(_resolveInstallMethod(undefined, true)).toBe("e2b");
      expect(_resolveInstallMethod(null, true)).toBe("e2b");
      expect(_resolveInstallMethod("garbage", true)).toBe("e2b");
    });

    test("missing/unrecognized value + no E2B → manual", () => {
      expect(_resolveInstallMethod(undefined, false)).toBe("manual");
      expect(_resolveInstallMethod("", false)).toBe("manual");
      expect(_resolveInstallMethod("  ", false)).toBe("manual");
      expect(_resolveInstallMethod("some-typo", false)).toBe("manual");
    });
  });

  describe("_resolveInstallPreset", () => {
    test("known wizard preset IDs pass through unchanged", () => {
      expect(_resolveInstallPreset("dev")).toBe("dev");
      expect(_resolveInstallPreset("content")).toBe("content");
      expect(_resolveInstallPreset("research")).toBe("research");
      expect(_resolveInstallPreset("solo")).toBe("solo");
      expect(_resolveInstallPreset("custom")).toBe("custom");
    });

    test("unrecognized value is omitted (not forwarded, not mapped to a sentinel)", () => {
      // Anything an operator could accidentally put in INSTALL_PRESET
      // (an email, a customer name, a typo) must never reach telemetry.
      expect(_resolveInstallPreset("taras@desplega.ai")).toBeUndefined();
      expect(_resolveInstallPreset("acme-corp")).toBeUndefined();
      expect(_resolveInstallPreset("Dev")).toBeUndefined(); // case-sensitive
      expect(_resolveInstallPreset("unknown")).toBeUndefined();
    });

    test("missing/blank value is omitted", () => {
      expect(_resolveInstallPreset(undefined)).toBeUndefined();
      expect(_resolveInstallPreset(null)).toBeUndefined();
      expect(_resolveInstallPreset("")).toBeUndefined();
      expect(_resolveInstallPreset("   ")).toBeUndefined();
    });
  });

  describe("_hasEmbeddingKey", () => {
    test("true when EMBEDDING_API_KEY is set", () => {
      expect(_hasEmbeddingKey({ EMBEDDING_API_KEY: "sk-embed" })).toBe(true);
    });

    test("true when OPENAI_API_KEY is set", () => {
      expect(_hasEmbeddingKey({ OPENAI_API_KEY: "sk-openai" })).toBe(true);
    });

    test("false when neither is set (onboard wizard only writes ANTHROPIC_API_KEY)", () => {
      expect(_hasEmbeddingKey({ ANTHROPIC_API_KEY: "sk-ant" })).toBe(false);
      expect(_hasEmbeddingKey({})).toBe(false);
    });
  });

  describe("_hasSlackChannel / _hasEmailChannel", () => {
    test("Slack requires both tokens", () => {
      expect(_hasSlackChannel({ SLACK_BOT_TOKEN: "xoxb-1" })).toBe(false);
      expect(_hasSlackChannel({ SLACK_APP_TOKEN: "xapp-1" })).toBe(false);
      expect(_hasSlackChannel({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" })).toBe(true);
    });

    test("Slack respects SLACK_DISABLE even with both tokens present", () => {
      expect(
        _hasSlackChannel({
          SLACK_BOT_TOKEN: "xoxb-1",
          SLACK_APP_TOKEN: "xapp-1",
          SLACK_DISABLE: "true",
        }),
      ).toBe(false);
    });

    test("Email requires AGENTMAIL_WEBHOOK_SECRET", () => {
      expect(_hasEmailChannel({})).toBe(false);
      expect(_hasEmailChannel({ AGENTMAIL_WEBHOOK_SECRET: "whsec_1" })).toBe(true);
    });

    test("Email respects AGENTMAIL_DISABLE even with secret present", () => {
      expect(
        _hasEmailChannel({ AGENTMAIL_WEBHOOK_SECRET: "whsec_1", AGENTMAIL_DISABLE: "1" }),
      ).toBe(false);
    });
  });

  describe("track() ships activation-funnel properties/metadata", () => {
    const originalFetch = globalThis.fetch;
    let captured: Record<string, unknown> | null = null;

    // The dev/CI shell may itself have OPENAI_API_KEY / EMBEDDING_API_KEY set
    // (e.g. for other tooling) — clear before AND after each test so that
    // ambient env never leaks into the "absent" assertions below.
    const clearEnv = () => {
      delete process.env.EMBEDDING_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_APP_TOKEN;
      delete process.env.AGENTMAIL_WEBHOOK_SECRET;
      delete process.env.INSTALL_METHOD;
      delete process.env.INSTALL_PRESET;
    };

    beforeEach(() => {
      captured = null;
      clearEnv();
      globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
        captured = init?.body ? JSON.parse(init.body) : null;
        return new Response(null, { status: 204 });
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      clearEnv();
    });

    test("defaults: no embedding key, no channels, install_method=manual, no install_preset", async () => {
      await initTelemetry(
        "api-server",
        async () => undefined,
        async () => {},
        { generateIfMissing: true },
      );

      track({ event: "server.started", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(properties.has_embedding_key).toBe(false);
      expect(properties.has_slack_channel).toBe(false);
      expect(properties.has_email_channel).toBe(false);
      expect(properties.has_notification_channel).toBe(false);
      expect(properties.install_method).toBe("manual");
      expect(metadata.install_preset).toBeUndefined();
      // Freshly minted install → install_created_at is set.
      expect(typeof metadata.install_created_at).toBe("string");
    });

    test("pre-existing installationId with no stored anchor → install_created_at is absent from the payload, not back-filled with now()", async () => {
      await initTelemetry(
        "api-server",
        async (key) =>
          key === "telemetry_installation_id" ? "install_existingnoanchor" : undefined,
        async () => {},
        { generateIfMissing: true },
      );

      track({ event: "server.started", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.install_created_at).toBeUndefined();
    });

    test("wizard install: INSTALL_METHOD + INSTALL_PRESET flow through to properties/metadata", async () => {
      process.env.INSTALL_METHOD = "onboard_noninteractive";
      process.env.INSTALL_PRESET = "solo";
      await initTelemetry(
        "api-server",
        async () => undefined,
        async () => {},
        { generateIfMissing: true },
      );

      track({ event: "server.started", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(properties.install_method).toBe("onboard_noninteractive");
      expect(metadata.install_preset).toBe("solo");
    });

    test("unrecognized INSTALL_PRESET is omitted from metadata, not forwarded as free text", async () => {
      process.env.INSTALL_PRESET = "someone@example.com";
      await initTelemetry(
        "api-server",
        async () => undefined,
        async () => {},
        { generateIfMissing: true },
      );

      track({ event: "server.started", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.install_preset).toBeUndefined();
    });

    test("channels + embedding key all present", async () => {
      process.env.EMBEDDING_API_KEY = "sk-embed";
      process.env.SLACK_BOT_TOKEN = "xoxb-1";
      process.env.SLACK_APP_TOKEN = "xapp-1";
      process.env.AGENTMAIL_WEBHOOK_SECRET = "whsec_1";
      await initTelemetry(
        "api-server",
        async () => undefined,
        async () => {},
        { generateIfMissing: true },
      );

      track({ event: "server.started", properties: {} });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      expect(properties.has_embedding_key).toBe(true);
      expect(properties.has_slack_channel).toBe(true);
      expect(properties.has_email_channel).toBe(true);
      expect(properties.has_notification_channel).toBe(true);
    });

    test("caller properties cannot override the cohort fields (spread last, like is_cloud/is_e2b)", async () => {
      await initTelemetry(
        "api-server",
        async () => undefined,
        async () => {},
        { generateIfMissing: true },
      );

      track({
        event: "test.event",
        properties: { has_slack_channel: true, install_method: "spoofed" },
      });
      await new Promise((r) => setTimeout(r, 0));

      const properties = (captured as { properties: Record<string, unknown> }).properties;
      expect(properties.has_slack_channel).toBe(false);
      expect(properties.install_method).toBe("manual");
    });

    test("caller metadata CAN override install_preset — same (accepted) permissiveness as organization_id today", async () => {
      process.env.INSTALL_PRESET = "solo";
      await initTelemetry(
        "api-server",
        async () => undefined,
        async () => {},
        { generateIfMissing: true },
      );

      track({ event: "test.event", metadata: { install_preset: "spoofed" } });
      await new Promise((r) => setTimeout(r, 0));

      const metadata = (captured as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.install_preset).toBe("spoofed");
    });
  });

  describe("ANONYMIZED_TELEMETRY=false opt-out covers the new fields too", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;

    beforeEach(() => {
      fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response(null, { status: 204 });
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      process.env.ANONYMIZED_TELEMETRY = "true";
    });

    test("disabled → initTelemetry never mints/persists, track() never fetches", async () => {
      process.env.ANONYMIZED_TELEMETRY = "false";
      const writes: Array<{ key: string; value: string }> = [];
      await initTelemetry(
        "api-server",
        async () => undefined,
        async (key, value) => {
          writes.push({ key, value });
        },
        { generateIfMissing: true },
      );
      expect(_getInstallationIdForTests()).toBeNull();
      expect(_getInstalledAtForTests()).toBeNull();
      expect(writes).toEqual([]);

      track({ event: "server.started", properties: {} });
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchCalled).toBe(false);
    });
  });
});
