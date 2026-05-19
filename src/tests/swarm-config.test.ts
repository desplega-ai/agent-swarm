import { describe, expect, test } from "bun:test";
import type { SwarmConfigPayload } from "../scripts-runtime/executors/types";
import { Redacted } from "../scripts-runtime/redacted";
import { SwarmConfig } from "../scripts-runtime/swarm-config";

const payload: SwarmConfigPayload = {
  system: {
    apiKey: { value: "test-api-key", isSecret: true },
    agentId: { value: "agent-1", isSecret: false },
    mcpBaseUrl: { value: "http://localhost:3013", isSecret: false },
  },
  user: {
    "user-key": { value: "user-value", isSecret: true },
  },
};

describe("SwarmConfig", () => {
  test("hydrates system values as Redacted values with metadata", () => {
    const config = new SwarmConfig(payload);
    expect(Redacted.value(config.apiKey)).toBe("test-api-key");
    expect(Redacted.meta(config.apiKey)).toEqual({ type: "system", isSecret: true });
    expect(Redacted.value(config.agentId)).toBe("agent-1");
    expect(Redacted.meta(config.mcpBaseUrl)).toEqual({ type: "system", isSecret: false });
  });

  test("returns user-set config values", () => {
    const config = new SwarmConfig(payload);
    const value = config.get("user-key");
    expect(value).toBeDefined();
    expect(Redacted.value(value!)).toBe("user-value");
    expect(Redacted.meta(value!)).toEqual({ type: "user", isSecret: true });
  });

  test("missing user keys return undefined", () => {
    const config = new SwarmConfig(payload);
    expect(config.get("missing")).toBeUndefined();
  });
});
