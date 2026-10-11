import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetTelemetryEnableForTests,
  initApiTelemetry,
  syncTelemetryEnabled,
} from "../be/telemetry-enable";
import {
  _getInstallationIdForTests,
  _resetTelemetryStateForTests,
  initTelemetry,
} from "../telemetry";

type Sent = {
  event: string;
  properties: Record<string, unknown>;
  context: Record<string, unknown>;
};

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("turning telemetry on at runtime", () => {
  const originalFetch = globalThis.fetch;
  const originalFlag = process.env.ANONYMIZED_TELEMETRY;
  const originalWebsite = process.env.SWARM_ORG_WEBSITE;
  let sent: Sent[];
  let store: Map<string, string>;
  const getConfig = async (key: string) => store.get(key);
  const setConfig = async (key: string, value: string) => {
    store.set(key, value);
  };

  beforeAll(() => {
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? "{}"));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.ANONYMIZED_TELEMETRY;
    else process.env.ANONYMIZED_TELEMETRY = originalFlag;
    if (originalWebsite === undefined) delete process.env.SWARM_ORG_WEBSITE;
    else process.env.SWARM_ORG_WEBSITE = originalWebsite;
    _resetTelemetryStateForTests();
    _resetTelemetryEnableForTests();
  });

  beforeEach(() => {
    sent = [];
    store = new Map();
    delete process.env.SWARM_ORG_WEBSITE;
    _resetTelemetryStateForTests();
    _resetTelemetryEnableForTests();
  });

  test("off at boot, on later: mints an install ID and sends telemetry.enabled once", async () => {
    process.env.ANONYMIZED_TELEMETRY = "false";
    await initApiTelemetry(getConfig, setConfig);
    expect(_getInstallationIdForTests()).toBeNull();

    process.env.ANONYMIZED_TELEMETRY = "true";
    expect(await syncTelemetryEnabled("banner")).toBe(true);
    expect(await syncTelemetryEnabled("settings")).toBe(false);
    await flush();

    expect(_getInstallationIdForTests()).toMatch(/^install_[0-9a-f]{16}$/);
    expect(store.get("telemetry_installation_id")).toBe(_getInstallationIdForTests() as string);
    const enabled = sent.filter((event) => event.event === "telemetry.enabled");
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.properties).toMatchObject({ via: "banner" });
  });

  test("a reload that leaves telemetry off sends nothing", async () => {
    process.env.ANONYMIZED_TELEMETRY = "false";
    await initApiTelemetry(getConfig, setConfig);
    expect(await syncTelemetryEnabled("settings")).toBe(false);
    await flush();
    expect(sent).toEqual([]);
  });

  test("the first boot of an install sends telemetry.enabled via env; later boots do not", async () => {
    process.env.ANONYMIZED_TELEMETRY = "true";
    await initApiTelemetry(getConfig, setConfig);
    await flush();
    expect(sent.filter((e) => e.event === "telemetry.enabled")[0]?.properties).toMatchObject({
      via: "env",
    });

    sent = [];
    _resetTelemetryStateForTests();
    _resetTelemetryEnableForTests();
    await initApiTelemetry(getConfig, setConfig);
    await flush();
    expect(sent.filter((e) => e.event === "telemetry.enabled")).toEqual([]);
  });

  test("events carry org_website from SWARM_ORG_WEBSITE", async () => {
    process.env.ANONYMIZED_TELEMETRY = "true";
    process.env.SWARM_ORG_WEBSITE = "acme.com";
    await initTelemetry("api-server", getConfig, setConfig, { generateIfMissing: true });
    _resetTelemetryEnableForTests();
    await initApiTelemetry(getConfig, setConfig);
    process.env.ANONYMIZED_TELEMETRY = "false";
    await syncTelemetryEnabled("settings");
    process.env.ANONYMIZED_TELEMETRY = "true";
    await syncTelemetryEnabled("settings");
    await flush();
    expect(sent.at(-1)?.context.org_website).toBe("acme.com");
  });
});
