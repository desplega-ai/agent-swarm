import { describe, expect, mock, test } from "bun:test";
import { BROWSER_SDK_JS } from "../pages/browser-sdk";

// ─── Browser SDK tests ─────────────────────────────────────────────────

describe("BROWSER_SDK_JS", () => {
  test("is a non-empty string", () => {
    expect(typeof BROWSER_SDK_JS).toBe("string");
    expect(BROWSER_SDK_JS.length).toBeGreaterThan(100);
  });

  test("contains SwarmSDK class", () => {
    expect(BROWSER_SDK_JS).toContain("class SwarmSDK");
  });

  test("is syntactically valid JavaScript", () => {
    expect(() => new Function(BROWSER_SDK_JS)).not.toThrow();
  });

  test("exposes the eight canonical domains", () => {
    const expectedDomains = [
      "this.tasks",
      "this.agents",
      "this.events",
      "this.memory",
      "this.repos",
      "this.schedules",
      "this.approvalRequests",
      "this.assets",
    ];
    for (const domain of expectedDomains) {
      expect(BROWSER_SDK_JS).toContain(domain);
    }
  });

  test("removed domains are NOT exposed (messages, services, slack)", () => {
    const removed = ["this.messages", "this.services", "this.slack", "postMessage", "readMessages"];
    for (const r of removed) {
      expect(BROWSER_SDK_JS).not.toContain(r);
    }
  });

  test("assigns SwarmSDK class + swarmSdk singleton to window", () => {
    expect(BROWSER_SDK_JS).toContain("window.SwarmSDK = SwarmSDK");
    expect(BROWSER_SDK_JS).toContain("window.swarmSdk = new SwarmSDK()");
  });

  test("routes calls through the /@swarm/api/* proxy", () => {
    expect(BROWSER_SDK_JS).toContain("const base = '/@swarm/api'");
    // Sentinel endpoints — one per domain.
    expect(BROWSER_SDK_JS).toContain("'/tasks'");
    expect(BROWSER_SDK_JS).toContain("'/agents'");
    expect(BROWSER_SDK_JS).toContain("'/events'");
    expect(BROWSER_SDK_JS).toContain("'/memory/search'");
    expect(BROWSER_SDK_JS).toContain("'/repos'");
    expect(BROWSER_SDK_JS).toContain("'/schedules'");
    expect(BROWSER_SDK_JS).toContain("'/approval-requests'");
    expect(BROWSER_SDK_JS).toContain("'/assets'");
    expect(BROWSER_SDK_JS).toContain("'/assets/key-audit'");
    expect(BROWSER_SDK_JS).toContain("'/assets/mappings'");
  });

  test("does not fetch on SDK load or construction", () => {
    const fetchMock = mock(() => Promise.resolve(Response.json({})));
    const window = {};
    const loadSdk = new Function("window", "fetch", `${BROWSER_SDK_JS}\nreturn window.SwarmSDK;`);

    const SwarmSDK = loadSdk(window, fetchMock);
    expect(window).toHaveProperty("swarmSdk");
    expect(fetchMock).not.toHaveBeenCalled();

    new SwarmSDK();
    new SwarmSDK();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
