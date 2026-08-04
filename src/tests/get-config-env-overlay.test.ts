import { afterEach, describe, expect, test } from "bun:test";
import { overlayOperatorEnvValue, overlayOperatorEnvValues } from "../be/swarm-config-guard";

type Entry = {
  id: string;
  scope: string;
  scopeId: string | null;
  key: string;
  value: string;
  isSecret: boolean;
  envPath: string | null;
  description: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  encrypted: boolean;
};

function row(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "row-1",
    scope: "global",
    scopeId: null,
    key: "DREAMING_ENABLED",
    value: "true",
    isSecret: false,
    envPath: null,
    description: null,
    createdAt: "",
    lastUpdatedAt: "",
    encrypted: false,
    ...overrides,
  };
}

const ENV_KEYS = ["DREAMING_ENABLED", "API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("get-config operator env overlay", () => {
  test("an env-only kill switch is visible without a stored row", () => {
    process.env.DREAMING_ENABLED = "false";
    const result = overlayOperatorEnvValue<Entry>([], "DREAMING_ENABLED");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: "DREAMING_ENABLED",
      scope: "global",
      value: "false",
      isSecret: false,
    });
  });

  test("a stored row that lost to env at boot reports the env value the server obeys", () => {
    process.env.DREAMING_ENABLED = "false";
    const result = overlayOperatorEnvValue([row({ value: "true" })], "DREAMING_ENABLED");
    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe("false");
    expect(result[0]?.description).toContain("stale until reload");
  });

  test("a stored row matching env passes through untouched", () => {
    process.env.DREAMING_ENABLED = "true";
    const stored = row({ value: "true" });
    expect(overlayOperatorEnvValue([stored], "DREAMING_ENABLED")).toEqual([stored]);
  });

  test("without the env var the rows are returned as-is", () => {
    delete process.env.DREAMING_ENABLED;
    expect(overlayOperatorEnvValue<Entry>([], "DREAMING_ENABLED")).toEqual([]);
  });

  test("non-catalog keys never resolve from env — no credential exposure path", () => {
    process.env.API_KEY = "super-secret";
    expect(overlayOperatorEnvValue<Entry>([], "API_KEY")).toEqual([]);
  });

  test("the all-keys overlay (REST /api/config/resolved path) surfaces env-only operator values", () => {
    // Scripts' ctx.swarm.config_get hits the REST route, which returns ALL
    // resolved configs and lets the SDK filter client-side — so the env overlay
    // must synthesize entries without a key filter, and still never leak
    // non-catalog env vars.
    process.env.DREAMING_ENABLED = "false";
    process.env.API_KEY = "super-secret";
    const result = overlayOperatorEnvValues<Entry>([row({ key: "OTHER", value: "x" })]);
    const dreaming = result.find((c) => c.key === "DREAMING_ENABLED");
    expect(dreaming?.value).toBe("false");
    expect(dreaming?.scope).toBe("global");
    expect(result.find((c) => c.key === "API_KEY")).toBeUndefined();
    expect(result.find((c) => c.key === "OTHER")?.value).toBe("x");
  });
});
