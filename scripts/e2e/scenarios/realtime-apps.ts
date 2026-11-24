import WebSocket from "ws";
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

type Frame = Record<string, unknown> & { type?: string; id?: number; seq?: number };

/** A dashboard socket on a one-shot ticket, with a frame waiter. */
async function openDashboardSocket(baseUrl: string, ticket: string) {
  const url = new URL("/api/realtime", baseUrl.replace(/^http/, "ws"));
  url.searchParams.set("ticket", ticket);
  const ws = new WebSocket(url, { headers: { Origin: baseUrl } });
  const frames: Frame[] = [];
  const waiters: { predicate: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  ws.on("message", (raw) => {
    let frame: Frame;
    try {
      frame = JSON.parse(raw.toString()) as Frame;
    } catch {
      return;
    }
    if (typeof frame.seq === "number" && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ack: frame.seq }));
    }
    const waiter = waiters.find((w) => w.predicate(frame));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    } else frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const next = (predicate: (f: Frame) => boolean, timeoutMs = 5_000): Promise<Frame | null> => {
    const index = frames.findIndex(predicate);
    if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]!);
    return new Promise((resolve) => {
      const waiter = { predicate, resolve: (f: Frame | null) => resolve(f) };
      waiters.push(waiter as never);
      setTimeout(() => {
        const at = waiters.indexOf(waiter as never);
        if (at >= 0) waiters.splice(at, 1);
        resolve(null);
      }, timeoutMs);
    });
  };
  let id = 0;
  const request = async (message: Record<string, unknown>): Promise<Frame | null> => {
    id += 1;
    const mine = id;
    ws.send(JSON.stringify({ id: mine, ...message }));
    return next((f) => f.id === mine && (f.type === "result" || f.type === "error"));
  };
  return { ws, next, request };
}

/**
 * App realtime over the existing socket: a dashboard ticket subscribes to
 * `app:<appId>` and gets a `rows` event after a row write; it joins the page's
 * presence room. Refused: a browser publish into the app channel, any op on an
 * app that does not exist, a non-default presence room.
 */
export const realtimeApps: Scenario = {
  name: "realtime-apps",
  order: 51,
  async run(ctx) {
    const definition = {
      models: { item: { columns: { title: { kind: "string" } } } },
      queries: { items: { model: "item" } },
      defaultPage: "home",
      pages: {
        home: {
          title: "Home",
          root: "who",
          elements: {
            who: { type: "AvatarStack", props: { users: { $state: "/presence/names" } } },
          },
        },
      },
    };
    let response = await ctx.api("POST", "/api/apps", {
      body: { name: `E2E realtime ${ctx.nonce}`, definition },
    });
    expectStatus(
      response,
      [201],
      `create the app (binds /presence/peers): ${response.text.slice(0, 300)}`,
    );
    const appId = String(asRecord(asRecord(response.json).app).id);
    try {
      response = await ctx.api("POST", "/api/realtime/ticket");
      expectStatus(response, [200], "issue a dashboard ticket");
      const socket = await openDashboardSocket(ctx.baseUrl, String(asRecord(response.json).ticket));
      try {
        const subscribed = await socket.request({
          op: "subscribe",
          namespace: `app:${appId}`,
          name: "rows",
        });
        expect(
          subscribed?.type === "result",
          `subscribe to the app channel: ${JSON.stringify(subscribed)}`,
        );

        response = await ctx.api("POST", `/api/apps/${appId}/models/item/rows`, {
          body: { values: { title: "hello" } },
        });
        expectStatus(response, [200, 201], `create a row: ${response.text.slice(0, 200)}`);
        const event = await socket.next(
          (f) => f.type === "channel" && f.namespace === `app:${appId}`,
        );
        expect(
          event !== null && JSON.stringify(event.data) === JSON.stringify({ model: "item" }),
          `a row write sends a rows event: ${JSON.stringify(event)}`,
        );

        const publish = await socket.request({
          op: "publish",
          namespace: `app:${appId}`,
          name: "rows",
          data: { model: "item" },
        });
        expect(
          publish?.type === "error",
          `a browser cannot publish into the app channel: ${JSON.stringify(publish)}`,
        );

        const missing = "00000000-0000-4000-8000-000000000000";
        const ghost = await socket.request({
          op: "subscribe",
          namespace: `app:${missing}`,
          name: "rows",
        });
        expect(ghost?.type === "error", `an unknown app is refused: ${JSON.stringify(ghost)}`);

        const joined = await socket.request({
          op: "join",
          namespace: `presence:app:${appId}:home`,
          name: "default",
          schemaVersion: 1,
        });
        expect(joined?.type === "result", `join the page presence room: ${JSON.stringify(joined)}`);
        const other = await socket.request({
          op: "join",
          namespace: `presence:app:${appId}:home`,
          name: "doc",
          schemaVersion: 1,
        });
        expect(other?.type === "error", `only the default presence room: ${JSON.stringify(other)}`);
        const write = await socket.request({
          op: "update",
          namespace: `presence:app:${appId}:home`,
          name: "default",
          update: "",
        });
        expect(
          write?.type === "error",
          `presence rooms take no document writes: ${JSON.stringify(write)}`,
        );
      } finally {
        socket.ws.close();
      }
    } finally {
      await ctx.api("DELETE", `/api/apps/${appId}`);
    }
  },
};
