import WebSocket from "ws";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";

type JsonRecord = Record<string, unknown>;
type Frame = {
  type?: string;
  id?: number;
  seq?: number;
  name?: string;
  namespace?: string;
  error?: string;
  room?: { namespace?: string; state?: JsonRecord; generation?: string };
  peers?: JsonRecord[];
  data?: unknown;
  [key: string]: unknown;
};

async function openPeer(
  baseUrl: string,
  pageId: string,
): Promise<{
  ws: WebSocket;
  frames: Frame[];
  next: (predicate: (frame: Frame) => boolean, timeoutMs?: number) => Promise<Frame>;
  send: (message: Record<string, unknown>) => void;
}> {
  const url = new URL("/@swarm/realtime", baseUrl.replace(/^http/, "ws"));
  url.searchParams.set("pageId", pageId);
  const ws = new WebSocket(url, { headers: { Origin: baseUrl } });
  const frames: Frame[] = [];
  const waiters: Array<{
    predicate: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  const next = (predicate: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> => {
    const index = frames.findIndex(predicate);
    if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((item) => item.timer === timer);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("Timed out waiting for realtime frame"));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  };
  const send = (message: Record<string, unknown>) => ws.send(JSON.stringify(message));
  ws.on("message", (raw) => {
    let frame: Frame;
    try {
      frame = JSON.parse(raw.toString()) as Frame;
    } catch {
      return;
    }
    if (typeof frame.seq === "number" && ws.readyState === WebSocket.OPEN) send({ ack: frame.seq });
    const waiter = waiters.find((item) => item.predicate(frame));
    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    } else {
      frames.push(frame);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("Timed out opening realtime socket"));
    }, 10_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
  return { ws, frames, next, send };
}

async function closePeer(peer: { ws: WebSocket }): Promise<void> {
  if (peer.ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    peer.ws.once("close", () => resolve());
    peer.ws.close();
  });
}

export const realtimeRooms: Scenario = {
  name: "realtime-rooms",
  async run(ctx) {
    const register = await ctx.api("POST", "/api/agents", {
      body: { name: `e2e-realtime-${ctx.nonce}`, role: "worker", status: "online" },
    });
    expectStatus(register, [201], "register realtime agent");
    const agentId = asRecord(register.json).id;
    expect(typeof agentId === "string", "Realtime agent response has no id");

    const page = await ctx.api("POST", "/api/pages", {
      agentId,
      body: {
        slug: `e2e-realtime-${ctx.nonce}`,
        title: "Realtime E2E",
        contentType: "text/html",
        authMode: "public",
        body: "<h1>realtime</h1>",
      },
    });
    expectStatus(page, [201], "create realtime page");
    const pageId = asRecord(page.json).id;
    expect(typeof pageId === "string", "Realtime page response has no id");
    const namespace = `task:page:${pageId}`;

    const peer = await openPeer(ctx.baseUrl, pageId);
    const mcp = await ctx.connectMcp(agentId);
    try {
      peer.send({ id: 1, op: "join", name: "shared", schemaVersion: 1 });
      const joined = await peer.next((frame) => frame.type === "result" && frame.id === 1);
      expect(joined.room?.namespace === namespace, "Page room used the wrong namespace");

      const workflow = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `e2e-realtime-wait-${ctx.nonce}`,
          definition: {
            nodes: [
              {
                id: "wait",
                type: "wait",
                config: {
                  mode: "event",
                  eventName: "room.changed",
                  filter: { namespace, room: "wait-room" },
                  scope: "global",
                  timeoutMs: 10_000,
                },
                next: { event: "done", timeout: "timeout" },
              },
              {
                id: "done",
                type: "notify",
                config: { channel: "swarm", template: "room changed" },
              },
              { id: "timeout", type: "notify", config: { channel: "swarm", template: "timeout" } },
            ],
          },
        },
      });
      expectStatus(workflow, [201], "create realtime wait workflow");
      const workflowId = asRecord(workflow.json).id;
      expect(typeof workflowId === "string", "Realtime workflow response has no id");
      const trigger = await ctx.api("POST", `/api/workflows/${workflowId}/trigger`, { body: {} });
      expectStatus(trigger, [201], "trigger realtime wait workflow");
      const runId = asRecord(trigger.json).runId;
      expect(typeof runId === "string", "Realtime workflow trigger has no run id");

      const changed = await mcp.callTool("room-change", {
        namespace,
        name: "shared",
        operations: [{ type: "set", path: ["fromMcp"], value: true }],
      });
      const changedRecord = asRecord(changed);
      expect(changedRecord.isError !== true, "room-change MCP call failed");
      await peer.next(
        (frame) =>
          frame.type === "room" &&
          frame.name === "shared" &&
          (frame.state as JsonRecord | undefined)?.fromMcp === true,
      );

      await mcp.callTool("room-change", {
        namespace,
        name: "wait-room",
        operations: [{ type: "set", path: ["wake"], value: ctx.nonce }],
      });
      let waitDetail: Record<string, unknown> | undefined;
      const terminal = await pollUntil(
        async () => {
          const response = await ctx.api("GET", `/api/workflow-runs/${runId}`);
          expectStatus(response, [200], "read realtime workflow run");
          waitDetail = asRecord(response.json);
          const run = asRecord(waitDetail.run);
          return ["completed", "failed", "cancelled", "skipped"].includes(String(run.status));
        },
        20_000,
        250,
      );
      expect(terminal, "room.changed wait did not reach a terminal state");
      expect(waitDetail, "room.changed wait returned no workflow detail");
      expect(asRecord(waitDetail.run).status === "completed", "room.changed wait workflow failed");
      const waitSteps = waitDetail.steps;
      expect(Array.isArray(waitSteps), "room.changed wait workflow has no steps");
      const doneStep = waitSteps.map(asRecord).find((step) => step.nodeId === "done");
      expect(doneStep?.status === "completed", "room.changed wait followed the timeout branch");

      const scriptName = `e2e-realtime-room-${ctx.nonce}`;
      const script = await ctx.api("POST", "/api/scripts/upsert", {
        agentId,
        body: {
          name: scriptName,
          scope: "agent",
          description: "Realtime room SDK E2E fixture",
          intent: "Verify nested room SDK methods inside a workflow node",
          source: `import type { ScriptContext } from "swarm-sdk";

export default async function main(
  args: { namespace: string; name: string; marker: string },
  ctx: ScriptContext,
) {
  const reset = await ctx.swarm.room.reset({
    namespace: args.namespace,
    name: args.name,
    state: { fromScript: args.marker },
  });
  const fetched = await ctx.swarm.room.get({ namespace: args.namespace, name: args.name });
  const changed = await ctx.swarm.room.change({
    namespace: args.namespace,
    name: args.name,
    operations: [{ type: "set", path: ["changedByScript"], value: true }],
  });
  const decoded = await ctx.swarm.room.decode({
    value: {
      format: "swarm-room-v1",
      schemaVersion: changed.schemaVersion,
      generation: changed.generation,
      snapshot: changed.snapshot,
    },
  });
  return {
    resetState: reset.state,
    fetchedState: fetched.state,
    changedState: changed.state,
    decodedState: decoded.state,
  };
}
`,
        },
      });
      expectStatus(script, [200], "upsert realtime room SDK script");

      const scriptWorkflow = await ctx.api("POST", "/api/workflows", {
        agentId,
        body: {
          name: `e2e-realtime-script-${ctx.nonce}`,
          definition: {
            nodes: [
              {
                id: "rooms",
                type: "swarm-script",
                config: {
                  scriptName,
                  scope: "agent",
                  args: { namespace, name: "script-room", marker: ctx.nonce },
                },
              },
            ],
          },
        },
      });
      expectStatus(scriptWorkflow, [201], "create realtime room script workflow");
      const scriptWorkflowId = asRecord(scriptWorkflow.json).id;
      expect(typeof scriptWorkflowId === "string", "Realtime script workflow has no id");
      const scriptTrigger = await ctx.api("POST", `/api/workflows/${scriptWorkflowId}/trigger`, {
        agentId,
        body: {},
      });
      expectStatus(scriptTrigger, [201], "trigger realtime room script workflow");
      const scriptRunId = asRecord(scriptTrigger.json).runId;
      expect(typeof scriptRunId === "string", "Realtime script workflow trigger has no run id");
      let scriptDetail: Record<string, unknown> | undefined;
      const scriptTerminal = await pollUntil(
        async () => {
          const response = await ctx.api("GET", `/api/workflow-runs/${scriptRunId}`, { agentId });
          expectStatus(response, [200], "read realtime script workflow run");
          scriptDetail = asRecord(response.json);
          const run = asRecord(scriptDetail.run);
          return ["completed", "failed", "cancelled", "skipped"].includes(String(run.status));
        },
        30_000,
        250,
      );
      expect(scriptTerminal && scriptDetail, "Realtime script workflow did not finish");
      const scriptRun = asRecord(scriptDetail.run);
      expect(
        scriptRun.status === "completed",
        `Realtime script workflow failed: ${JSON.stringify(scriptDetail).slice(0, 1_000)}`,
      );
      const scriptSteps = scriptDetail.steps;
      expect(Array.isArray(scriptSteps), "Realtime script workflow has no steps");
      const roomStep = scriptSteps.map(asRecord).find((step) => step.nodeId === "rooms");
      const scriptResult = asRecord(asRecord(roomStep).output).result;
      const result = asRecord(scriptResult);
      expect(
        asRecord(result.resetState).fromScript === ctx.nonce &&
          asRecord(result.fetchedState).fromScript === ctx.nonce &&
          asRecord(result.changedState).changedByScript === true &&
          asRecord(result.decodedState).changedByScript === true,
        "Realtime room SDK workflow result did not round-trip through get, change, reset, and decode",
      );

      await Bun.sleep(1_200);
    } finally {
      await mcp.close();
      await closePeer(peer);
    }

    await ctx.restartSut();
    const restored = await openPeer(ctx.baseUrl, pageId);
    try {
      restored.send({ id: 2, op: "join", name: "shared", schemaVersion: 1 });
      const result = await restored.next((frame) => frame.type === "result" && frame.id === 2);
      expect(result.room?.state?.fromMcp === true, "Restarted room lost MCP state");
    } finally {
      await closePeer(restored);
    }
  },
};
