import { describe, expect, test } from "bun:test";
import { getApiKey, setApiKey } from "../utils/api-key";

describe("getApiKey", () => {
  test("returns empty string when neither var is set", () => {
    expect(getApiKey({})).toBe("");
  });

  test("returns API_KEY when only legacy var is set", () => {
    expect(getApiKey({ API_KEY: "legacy" })).toBe("legacy");
  });

  test("returns AGENT_SWARM_API_KEY when only preferred var is set", () => {
    expect(getApiKey({ AGENT_SWARM_API_KEY: "preferred" })).toBe("preferred");
  });

  test("prefers AGENT_SWARM_API_KEY over API_KEY when both set", () => {
    expect(getApiKey({ AGENT_SWARM_API_KEY: "preferred", API_KEY: "legacy" })).toBe("preferred");
  });

  test("falls back to API_KEY if AGENT_SWARM_API_KEY is undefined", () => {
    expect(getApiKey({ AGENT_SWARM_API_KEY: undefined, API_KEY: "x" })).toBe("x");
  });
});

describe("setApiKey", () => {
  test("populates both env var names", () => {
    const env: Record<string, string | undefined> = {};
    setApiKey("k", env);
    expect(env.AGENT_SWARM_API_KEY).toBe("k");
    expect(env.API_KEY).toBe("k");
  });
});
