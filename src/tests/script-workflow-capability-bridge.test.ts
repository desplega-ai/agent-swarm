import { describe, expect, test } from "bun:test";
import {
  createCapabilityClient,
  handleCapabilityRequest,
} from "../script-workflows/capability-bridge";
import { dispatchCapability } from "../script-workflows/executor";
import { buildGuestWorkflowCtx } from "../script-workflows/guest-ctx";
import type { BuiltWorkflowCtx } from "../script-workflows/workflow-ctx";

describe("script workflow capability bridge", () => {
  test("guest exposes only the explicit workflow swarm capability allowlist", async () => {
    const calls: Array<{ path: string; argsJson: string }> = [];
    const ctx = buildGuestWorkflowCtx({
      runId: "run-1",
      agentId: "agent-1",
      args: null,
      invokeTool: async (path, argsJson) => {
        calls.push({ path, argsJson });
        return JSON.stringify({ ok: true });
      },
    });

    await expect(ctx.swarm.agent_info()).resolves.toEqual({ ok: true });
    expect(ctx.swarm.config).toBeUndefined();
    expect(ctx.swarm.future_sensitive_property).toBeUndefined();
    expect(calls).toEqual([{ path: "swarm.agent_info", argsJson: "{}" }]);
  });

  test("host rejects sensitive and unknown swarm properties before accessing their values", async () => {
    const accessed: string[] = [];
    const swarm = new Proxy(
      { agent_info: async () => ({ ok: true }) },
      {
        get(target, prop, receiver) {
          accessed.push(String(prop));
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const built = { ctx: { swarm } } as unknown as BuiltWorkflowCtx;

    await expect(dispatchCapability(built, "swarm.config", "{}")).rejects.toThrow(
      "Workflow swarm capability 'config' is not allowlisted",
    );
    await expect(
      dispatchCapability(built, "swarm.future_sensitive_property", "{}"),
    ).rejects.toThrow("Workflow swarm capability 'future_sensitive_property' is not allowlisted");
    expect(accessed).toEqual([]);

    await expect(dispatchCapability(built, "swarm.agent_info", "{}")).resolves.toBe('{"ok":true}');
    expect(accessed).toEqual(["agent_info"]);
  });

  test("correlates concurrent JSON calls when responses arrive out of order", async () => {
    const requests: string[] = [];
    const client = createCapabilityClient((message) => requests.push(message));

    const first = client.invokeTool("swarm.task_get", JSON.stringify({ taskId: "first" }));
    const second = client.invokeTool("swarm.task_get", JSON.stringify({ taskId: "second" }));
    expect(requests.every((request) => typeof request === "string")).toBe(true);

    const dispatch = async (_path: string, argsJson: string) => argsJson;
    client.handleMessage(await handleCapabilityRequest(requests[1]!, dispatch));
    client.handleMessage(await handleCapabilityRequest(requests[0]!, dispatch));

    expect(JSON.parse(await first)).toEqual({ taskId: "first" });
    expect(JSON.parse(await second)).toEqual({ taskId: "second" });
  });

  test("round-trips values and serialized errors", async () => {
    let client: ReturnType<typeof createCapabilityClient>;
    client = createCapabilityClient(async (message) => {
      await handleCapabilityRequest(
        message,
        async (path, argsJson) => {
          if (path === "step.fail") throw new TypeError(`rejected ${JSON.parse(argsJson).label}`);
          return JSON.stringify({ path, args: JSON.parse(argsJson) });
        },
        (response) => client.handleMessage(response),
      );
    });

    await expect(client.invokeTool("step.fail", '{"label":"now"}')).rejects.toMatchObject({
      name: "TypeError",
      message: "rejected now",
    });
    expect(JSON.parse(await client.invokeTool("swarm.echo", '{"ok":true}'))).toEqual({
      path: "swarm.echo",
      args: { ok: true },
    });
  });

  test("rejects malformed request and response envelopes", async () => {
    await expect(handleCapabilityRequest({}, async () => "null")).rejects.toThrow(
      "Malformed capability request: expected a JSON string",
    );
    await expect(handleCapabilityRequest("not json", async () => "null")).rejects.toThrow(
      "Malformed capability request: expected valid JSON",
    );
    await expect(
      handleCapabilityRequest(
        JSON.stringify({ type: "invoke", id: "1", path: "swarm.echo", argsJson: "nope" }),
        async () => "null",
      ),
    ).rejects.toThrow("`argsJson` must contain valid JSON");

    const client = createCapabilityClient(() => {});
    expect(() => client.handleMessage(JSON.stringify({ type: "result", id: "1" }))).toThrow(
      "expected string `resultJson`",
    );
    expect(() =>
      client.handleMessage(JSON.stringify({ type: "result", id: "unknown", resultJson: "null" })),
    ).toThrow("unknown request id `unknown`");
  });

  test("rejects pending and future calls after disconnect", async () => {
    const client = createCapabilityClient(() => {});
    const pending = client.invokeTool("swarm.wait", "{}");
    const disconnectError = new Error("guest exited");

    client.disconnect(disconnectError);

    await expect(pending).rejects.toBe(disconnectError);
    await expect(client.invokeTool("swarm.late", "{}")).rejects.toBe(disconnectError);
  });

  test("returns a correlated error when a marshaled result exceeds the limit", async () => {
    let client: ReturnType<typeof createCapabilityClient>;
    client = createCapabilityClient(async (message) => {
      client.handleMessage(
        await handleCapabilityRequest(
          message,
          async () => JSON.stringify("x".repeat(300)),
          undefined,
          256,
        ),
      );
    });

    await expect(client.invokeTool("swarm.large", "{}")).rejects.toThrow(
      /Capability result for swarm\.large exceeded the 256-byte hard limit/,
    );
  });

  test("caps the complete IPC envelope, including escaping and serialized errors", async () => {
    const escaped = await handleCapabilityRequest(
      JSON.stringify({ type: "invoke", id: "1", path: "swarm.escaped", argsJson: "{}" }),
      async () => JSON.stringify('"'.repeat(180)),
      undefined,
      256,
    );
    expect(new TextEncoder().encode(escaped).byteLength).toBeLessThanOrEqual(256);
    expect(JSON.parse(escaped).type).toBe("error");

    const largeError = await handleCapabilityRequest(
      JSON.stringify({ type: "invoke", id: "2", path: "swarm.error", argsJson: "{}" }),
      async () => {
        throw new Error("x".repeat(500));
      },
      undefined,
      256,
    );
    expect(new TextEncoder().encode(largeError).byteLength).toBeLessThanOrEqual(256);
    expect(JSON.parse(largeError).error.message).toContain("exceeded the 256-byte hard limit");
  });
});
