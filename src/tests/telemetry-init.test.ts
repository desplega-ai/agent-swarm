import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _getInstallationIdForTests,
  _resetTelemetryStateForTests,
  initTelemetry,
  track,
} from "../telemetry";

// initTelemetry no-ops when ANONYMIZED_TELEMETRY=false. The CI env or local
// setup may set this, so force-enable for the duration of this file.
process.env.ANONYMIZED_TELEMETRY = "true";

describe("initTelemetry", () => {
  beforeEach(() => {
    _resetTelemetryStateForTests();
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
});
