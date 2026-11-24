import WebSocket from "ws";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerAgent } from "./knowledge-helpers";

type Frame = Record<string, unknown> & { type?: string; id?: number; seq?: number };

async function openSocket(baseUrl: string, query: string, headers: Record<string, string> = {}) {
  const url = new URL(`/api/realtime?${query}`, baseUrl.replace(/^http/, "ws"));
  const ws = new WebSocket(url, { headers: { Origin: baseUrl, ...headers } });
  const frames: Frame[] = [];
  const waiters: { p: (f: Frame) => boolean; r: (f: Frame | null) => void }[] = [];
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString()) as Frame;
    if (typeof f.seq === "number" && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ack: f.seq }));
    }
    const w = waiters.find((x) => x.p(f));
    if (w) {
      waiters.splice(waiters.indexOf(w), 1);
      w.r(f);
    } else frames.push(f);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = (p: (f: Frame) => boolean, ms = 3_000) => {
    const i = frames.findIndex(p);
    if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0]!);
    return new Promise<Frame | null>((r) => {
      const w = { p, r };
      waiters.push(w);
      setTimeout(() => {
        const at = waiters.indexOf(w);
        if (at >= 0) {
          waiters.splice(at, 1);
          r(null);
        }
      }, ms);
    });
  };
  let id = 0;
  const request = (m: Record<string, unknown>) => {
    const mine = ++id;
    ws.send(JSON.stringify({ id: mine, ...m }));
    return next((f) => f.id === mine && (f.type === "result" || f.type === "error"));
  };
  return { ws, request, next, frames };
}

/** Who may use app realtime: a worker's key with X-Agent-ID and a user without `app.use` get nothing. */
export const realtimeAppsGuards: Scenario = {
  name: "realtime-apps-guards",
  order: 52,
  async run(ctx) {
    const agent = await registerAgent(ctx, "realtime-apps-guards");
    let response = await ctx.api("POST", "/api/apps", {
      body: {
        name: `E2E realtime guards ${ctx.nonce}`,
        definition: {
          models: { item: { columns: { title: { kind: "string" } } } },
          queries: { items: { model: "item" } },
          defaultPage: "home",
          pages: {
            home: {
              title: "Home",
              root: "who",
              elements: { who: { type: "AvatarStack", props: { users: { $state: "/presence/names" } } } },
            },
          },
        },
      },
    });
    expectStatus(response, [201], "create the app");
    const appId = String(asRecord(asRecord(response.json).app).id);
    const sockets: WebSocket[] = [];
    try {
      // A worker (swarm key + X-Agent-ID) is not a dashboard viewer.
      const worker = await openSocket(ctx.baseUrl, "", {
        Authorization: `Bearer ${ctx.apiKey}`,
        "X-Agent-ID": agent,
      });
      sockets.push(worker.ws);
      const workerSub = await worker.request({ op: "subscribe", namespace: `app:${appId}`, name: "rows" });
      expect(workerSub?.type === "error", `a worker cannot subscribe: ${JSON.stringify(workerSub)}`);
      const workerJoin = await worker.request({
        op: "join",
        namespace: `presence:app:${appId}:home`,
        name: "default",
        schemaVersion: 1,
      });
      expect(workerJoin?.type === "error", `a worker cannot join presence: ${JSON.stringify(workerJoin)}`);

      // A user whose role lacks `app.use` (viewer) still gets a ticket (session presence) but no app realtime.
      // The first user is the last admin: create one to keep, then the viewer.
      await ctx.api("POST", "/api/users", {
        body: { name: `guards admin ${ctx.nonce}`, status: "active" },
      });
      const created = await ctx.api("POST", "/api/users", {
        body: { name: `guards viewer ${ctx.nonce}`, status: "active" },
      });
      expectStatus(created, [200], "create the viewer");
      const userId = asString(asRecord(asRecord(created.json).user).id, "user id");
      response = await ctx.api("PUT", `/api/users/${userId}/roles`, { body: { roles: ["viewer"] } });
      expectStatus(response, [200], "make the user a viewer");
      response = await ctx.api("POST", `/api/users/${userId}/mcp-tokens`, { body: { label: "guards" } });
      expectStatus(response, [200], "mint the viewer token");
      const token = asString(asRecord(response.json).plaintext, "token");
      response = await ctx.api("POST", "/api/realtime/ticket", { apiKey: token });
      expectStatus(response, [200], "a viewer gets a ticket");
      const viewer = await openSocket(ctx.baseUrl, `ticket=${asRecord(response.json).ticket}`);
      sockets.push(viewer.ws);
      const viewerSub = await viewer.request({ op: "subscribe", namespace: `app:${appId}`, name: "rows" });
      expect(viewerSub?.type === "error", `a viewer cannot subscribe: ${JSON.stringify(viewerSub)}`);
      const viewerJoin = await viewer.request({
        op: "join",
        namespace: `presence:app:${appId}:home`,
        name: "default",
        schemaVersion: 1,
      });
      expect(viewerJoin?.type === "error", `a viewer cannot join presence: ${JSON.stringify(viewerJoin)}`);

      // Five quick writes reach an operator socket as one event.
      response = await ctx.api("POST", "/api/realtime/ticket");
      const operator = await openSocket(ctx.baseUrl, `ticket=${asRecord(response.json).ticket}`);
      sockets.push(operator.ws);
      const sub = await operator.request({ op: "subscribe", namespace: `app:${appId}`, name: "rows" });
      expect(sub?.type === "result", `an operator subscribes: ${JSON.stringify(sub)}`);
      for (let i = 0; i < 5; i++) {
        response = await ctx.api("POST", `/api/apps/${appId}/models/item/rows`, {
          body: { values: { title: `row ${i}` } },
        });
        expectStatus(response, [200, 201], "create a row");
      }
      const first = await operator.next((f) => f.type === "channel");
      expect(first !== null, "a rows event arrives");
      const second = await operator.next((f) => f.type === "channel", 800);
      expect(second === null, `five quick writes make one event: ${JSON.stringify(second)}`);
    } finally {
      for (const ws of sockets) ws.close();
      await ctx.api("DELETE", `/api/apps/${appId}`);
    }
  },
};
