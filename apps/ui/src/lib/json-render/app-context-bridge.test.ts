import { expect, test } from "bun:test";
import {
  APP_CONTEXT_RATE_PER_SEC,
  appFrameQuery,
  createAppContextHost,
  frameParams,
} from "./app-context-bridge";

function host(overrides: Partial<Parameters<typeof createAppContextHost>[0]> = {}) {
  const calls = { actions: [] as unknown[], navigate: [] as unknown[], deliver: [] as unknown[] };
  let t = 0;
  const h = createAppContextHost({
    allowedActions: () => ["traceDetail"],
    messageId: () => "waterfall",
    runAction: async (name, input) => {
      calls.actions.push([name, input]);
      return { status: "ok", result: { spans: 3 } };
    },
    navigate: (page, params) => calls.navigate.push([page, params]),
    deliver: (id, message) => calls.deliver.push([id, message]),
    now: () => t,
    ...overrides,
  });
  return { h, calls, advance: (ms: number) => (t += ms) };
}

test("runs only allowlisted actions and replies with the result", async () => {
  const { h, calls } = host();
  expect(
    await h.handle({ type: "swarm-app:action", id: 1, name: "traceDetail", input: { a: 1 } }),
  ).toEqual({
    type: "swarm-app:result",
    id: 1,
    result: { status: "ok", result: { spans: 3 } },
  });
  const refused = await h.handle({ type: "swarm-app:action", id: 2, name: "deleteAll" });
  expect(refused?.result).toEqual({
    status: "error",
    error: 'appContext: action "deleteAll" is not in this PageFrame\'s actions',
  });
  expect(calls.actions).toEqual([["traceDetail", { a: 1 }]]);
});

test("a throwing action comes back as an error result", async () => {
  const { h } = host({
    runAction: async () => {
      throw new Error("boom");
    },
  });
  const reply = await h.handle({ type: "swarm-app:action", id: 7, name: "traceDetail" });
  expect(reply?.result).toEqual({ status: "error", error: "boom" });
});

test("caps requests per second and per size", async () => {
  const { h, calls, advance } = host();
  for (let i = 0; i < APP_CONTEXT_RATE_PER_SEC; i++) {
    await h.handle({ type: "swarm-app:action", id: i, name: "traceDetail" });
  }
  const limited = await h.handle({ type: "swarm-app:action", id: 99, name: "traceDetail" });
  expect(limited?.result).toEqual({ status: "error", error: "appContext: rate limited" });
  expect(calls.actions.length).toBe(APP_CONTEXT_RATE_PER_SEC);
  advance(1000);
  const big = await h.handle({
    type: "swarm-app:action",
    id: 100,
    name: "traceDetail",
    input: "x".repeat(70_000),
  });
  expect(big?.result).toEqual({ status: "error", error: "appContext: request over 64 KiB" });
});

test("navigate takes a page name and scalar params only", async () => {
  const { h, calls } = host();
  await h.handle({ type: "swarm-app:navigate", page: "span", params: { spanId: "s1", n: 2 } });
  await h.handle({ type: "swarm-app:navigate", page: "../../settings" });
  await h.handle({ type: "swarm-app:navigate", page: "span", params: { deep: { a: 1 } } });
  expect(calls.navigate).toEqual([["span", { spanId: "s1", n: "2" }]]);
});

test("emit delivers numbered messages, and is dropped without a frame id", async () => {
  const { h, calls } = host();
  await h.handle({ type: "swarm-app:emit", name: "open", data: { spanId: "s1" } });
  await h.handle({ type: "swarm-app:emit", name: "open" });
  expect(calls.deliver).toEqual([
    ["waterfall", { name: "open", data: { spanId: "s1" }, seq: 1 }],
    ["waterfall", { name: "open", data: null, seq: 2 }],
  ]);
  const bare = host({ messageId: () => undefined });
  await bare.h.handle({ type: "swarm-app:emit", name: "open" });
  expect(bare.calls.deliver).toEqual([]);
});

test("frame query carries scalar params and the app marker, never reserved names", () => {
  const params = { traceId: "t1", n: 3, on: true, obj: { a: 1 }, "__swarm-mode": "dark" };
  expect(appFrameQuery("app1", params)).toBe("?traceId=t1&n=3&on=true&__swarm_app=app1");
  expect(appFrameQuery(null, undefined)).toBe("");
  expect(frameParams(params)).toEqual({ traceId: "t1", n: "3", on: "true" });
});
