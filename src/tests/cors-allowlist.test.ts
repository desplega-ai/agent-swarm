import { afterEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isOriginAllowedForCredentials, setCorsHeaders } from "../http/utils";

const ENV_KEY = "CORS_ALLOWED_ORIGINS";
const originalEnv = process.env[ENV_KEY];

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
});

function fakeReq(origin: string | undefined): IncomingMessage {
  return { headers: origin ? { origin } : {} } as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  const res = {
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    },
  } as unknown as ServerResponse;
  return { res, headers };
}

describe("isOriginAllowedForCredentials", () => {
  test("allows any origin when CORS_ALLOWED_ORIGINS is unset (legacy behavior)", () => {
    delete process.env[ENV_KEY];
    expect(isOriginAllowedForCredentials("https://evil.example")).toBe(true);
  });

  test("allows any origin when CORS_ALLOWED_ORIGINS is empty", () => {
    process.env[ENV_KEY] = "  ";
    expect(isOriginAllowedForCredentials("https://evil.example")).toBe(true);
  });

  test("allows only listed origins when set", () => {
    process.env[ENV_KEY] = "https://app.example.com, https://dashboard.example.com";
    expect(isOriginAllowedForCredentials("https://app.example.com")).toBe(true);
    expect(isOriginAllowedForCredentials("https://dashboard.example.com")).toBe(true);
    expect(isOriginAllowedForCredentials("https://evil.example")).toBe(false);
  });

  test.each([
    ["matches a subdomain", "https://app.agent-swarm.dev", true],
    ["matches multiple subdomain labels", "https://a.b.agent-swarm.dev", true],
    ["rejects suffix confusion", "https://evil-agent-swarm.dev", false],
    ["rejects trailing-domain attacks", "https://app.agent-swarm.dev.evil.com", false],
    ["rejects scheme mismatch", "http://app.agent-swarm.dev", false],
    ["compares scheme exactly", "HTTPS://app.agent-swarm.dev", false],
    ["rejects the apex", "https://agent-swarm.dev", false],
    ["compares host case-insensitively", "https://APP.AGENT-SWARM.DEV", true],
    ["rejects an unlisted port", "https://app.agent-swarm.dev:8443", false],
    ["rejects empty labels", "https://.agent-swarm.dev", false],
    ["rejects credentials", "https://evil.com@app.agent-swarm.dev", false],
    ["rejects paths", "https://app.agent-swarm.dev/evil", false],
  ])("wildcard %s", (_name, origin, allowed) => {
    process.env[ENV_KEY] = "https://*.agent-swarm.dev";
    expect(isOriginAllowedForCredentials(origin)).toBe(allowed);
  });

  test.each([
    "*",
    "https://*",
    "https://*.*.agent-swarm.dev",
    "https://app*.agent-swarm.dev",
  ])("ignores invalid wildcard entry %s", (entry) => {
    process.env[ENV_KEY] = entry;
    expect(isOriginAllowedForCredentials("https://app.agent-swarm.dev")).toBe(false);
    expect(isOriginAllowedForCredentials(entry)).toBe(false);
  });

  test("wildcard supports uppercase suffixes and requires the configured port", () => {
    process.env[ENV_KEY] = "https://*.AGENT-SWARM.DEV:8443";
    expect(isOriginAllowedForCredentials("https://app.agent-swarm.dev:8443")).toBe(true);
    expect(isOriginAllowedForCredentials("https://app.agent-swarm.dev")).toBe(false);
    expect(isOriginAllowedForCredentials("https://app.agent-swarm.dev:443")).toBe(false);
  });

  test("mixes wildcard and exact entries including a separately listed apex", () => {
    process.env[ENV_KEY] =
      "https://*.agent-swarm.dev,https://agent-swarm.dev,http://localhost:5274";
    expect(isOriginAllowedForCredentials("https://app.agent-swarm.dev")).toBe(true);
    expect(isOriginAllowedForCredentials("https://agent-swarm.dev")).toBe(true);
    expect(isOriginAllowedForCredentials("http://localhost:5274")).toBe(true);
    expect(isOriginAllowedForCredentials("http://localhost:5275")).toBe(false);
  });

  test("is an exact match, not a suffix/subdomain match", () => {
    process.env[ENV_KEY] = "https://app.example.com";
    expect(isOriginAllowedForCredentials("https://evil.app.example.com")).toBe(false);
    expect(isOriginAllowedForCredentials("https://app.example.com.evil.example")).toBe(false);
  });
});

describe("setCorsHeaders", () => {
  test("legacy: reflects any origin with credentials when allowlist unset", () => {
    delete process.env[ENV_KEY];
    const { res, headers } = fakeRes();
    setCorsHeaders(fakeReq("https://evil.example"), res);
    expect(headers.get("access-control-allow-origin")).toBe("https://evil.example");
    expect(headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("denies a non-allowlisted origin: no Allow-Origin, no Allow-Credentials", () => {
    process.env[ENV_KEY] = "https://app.example.com";
    const { res, headers } = fakeRes();
    setCorsHeaders(fakeReq("https://evil.example"), res);
    expect(headers.has("access-control-allow-origin")).toBe(false);
    expect(headers.has("access-control-allow-credentials")).toBe(false);
    // Vary: Origin still set so caches don't serve a denied response to an allowed origin.
    expect(headers.get("vary")).toBe("Origin");
  });

  test("allows a listed origin with credentials", () => {
    process.env[ENV_KEY] = "https://app.example.com";
    const { res, headers } = fakeRes();
    setCorsHeaders(fakeReq("https://app.example.com"), res);
    expect(headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("no-Origin requests still get wildcard regardless of allowlist", () => {
    process.env[ENV_KEY] = "https://app.example.com";
    const { res, headers } = fakeRes();
    setCorsHeaders(fakeReq(undefined), res);
    expect(headers.get("access-control-allow-origin")).toBe("*");
  });
});
