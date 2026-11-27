import { expect, test } from "bun:test";
import {
  createModelDiscovery,
  metadataUrl,
  parseDiscoveryConfig,
} from "../utils/provider-model-discovery";

const fixture = {
  data: [
    {
      model_name: "example-large-chat",
      model_info: { max_input_tokens: 922000, max_output_tokens: 128000 },
      litellm_params: { api_key: "never-retain" },
    },
  ],
};
const route = {
  provider: "openrouter",
  baseURL: "https://gateway.example/gateway/v1",
  key: "synthetic-key",
  modelId: "example-large-chat",
};

test("path contract retains prefix, forbids userinfo/query/unsafe scheme", () => {
  expect(metadataUrl(route.baseURL)).toBe("https://gateway.example/gateway/model/info");
  expect(metadataUrl("https://gateway.example/gateway")).toBe(
    "https://gateway.example/gateway/model/info",
  );
  for (const url of [
    "ftp://gateway.example",
    "https://user:pass@gateway.example",
    "https://gateway.example?a=b",
    "https://gateway.example/#fragment",
  ]) {
    expect(() => metadataUrl(url)).toThrow();
  }
});
test("config is opt-in and strictly bounded", () => {
  expect(parseDiscoveryConfig(undefined)).toEqual({});
  expect(parseDiscoveryConfig("{}")).toEqual({});
  for (const config of [
    "[]",
    "null",
    '{"openrouter":{"mode":"auto"}}',
    JSON.stringify({ openrouter: { mode: "litellm", baseURL: route.baseURL, ttlMs: 0 } }),
  ]) {
    expect(() => parseDiscoveryConfig(config)).toThrow("PROVIDER_MODEL_DISCOVERY");
  }
});
test("selected key isolation, rotation, URL identity, TTL, single-flight, sanitized facts only", async () => {
  let now = 0;
  let calls = 0;
  const discover = createModelDiscovery({
    now: () => now,
    fetchImpl: (async (_url, init) => {
      calls++;
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer synthetic/);
      expect(init?.redirect).toBe("error");
      return Response.json(fixture);
    }) as typeof fetch,
  });
  const [first, second] = await Promise.all([discover(route), discover(route)]);
  expect(calls).toBe(1);
  expect(first).toEqual(second);
  expect(first?.limits).toEqual({ input: 922000, output: 128000 });
  expect(JSON.stringify(first)).not.toContain("never-retain");
  await discover({ ...route, key: "synthetic-rotated" });
  await discover({ ...route, baseURL: "https://gateway.example/other/v1" });
  expect(calls).toBe(3);
  now = 300001;
  await discover(route);
  expect(calls).toBe(4);
  expect(await discover({ ...route, key: "a,b" })).toMatchObject({ diagnostic: "invalid-route" });
  expect(calls).toBe(4);
});
test("bounded stale on transient failures, negative backoff, stale expiry and denial invalidation", async () => {
  let now = 0;
  let status = 200;
  let calls = 0;
  const discover = createModelDiscovery({
    now: () => now,
    fetchImpl: (async () => {
      calls++;
      return status === 200
        ? Response.json(fixture)
        : new Response("secret-error-body", { status });
    }) as typeof fetch,
  });
  await discover(route);
  now = 300001;
  status = 503;
  expect(await discover(route)).toMatchObject({
    stale: true,
    limits: { input: 922000 },
    diagnostic: "unavailable",
  });
  await discover(route);
  expect(calls).toBe(2);
  now += 30001;
  status = 401;
  expect(await discover(route)).toMatchObject({ diagnostic: "access-denied" });
  now += 30001;
  status = 503;
  expect((await discover(route)).limits).toBeUndefined();
  now += 30001;
  status = 200;
  await discover(route);
  now += 86400001;
  status = 503;
  expect((await discover(route)).limits).toBeUndefined();
});
test("malformed, oversized, denied, unsupported and redirect responses never expose raw bodies", async () => {
  for (const response of [
    new Response("secret"),
    Response.json({ data: {} }),
    new Response("secret", { status: 403 }),
    new Response("secret", { status: 404 }),
    new Response("secret", { status: 405 }),
    new Response("secret", { status: 429 }),
    new Response("secret", { status: 302 }),
    new Response("x".repeat(1048577)),
  ]) {
    const discover = createModelDiscovery({ fetchImpl: (async () => response) as typeof fetch });
    const result = await discover(route);
    expect(result.limits).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret");
  }
});
test("timeout covers headers and body even for an uncooperative injected fetch", async () => {
  const discover = createModelDiscovery({
    fetchImpl: (() => new Promise(() => {})) as typeof fetch,
  });
  expect(await discover({ ...route, timeoutMs: 10 })).toMatchObject({ diagnostic: "unavailable" });
});

test("body timeout keeps stale facts; changed credential scope and provider cannot share them", async () => {
  let now = 0;
  let stalled = false;
  let calls = 0;
  const discover = createModelDiscovery({
    now: () => now,
    fetchImpl: (async () => {
      calls++;
      return stalled ? new Response(new ReadableStream({ start() {} })) : Response.json(fixture);
    }) as typeof fetch,
  });
  await discover(route);
  now = 300001;
  stalled = true;
  expect(await discover({ ...route, timeoutMs: 10 })).toMatchObject({
    stale: true,
    diagnostic: "unavailable",
  });
  stalled = false;
  await discover({ ...route, scope: "another-agent" });
  await discover({ ...route, provider: "helmcode" });
  expect(calls).toBe(4);
});

test("real cross-origin redirects never forward the bearer", async () => {
  let received = 0;
  const target = Bun.serve({
    port: 0,
    fetch: () => {
      received++;
      return Response.json(fixture);
    },
  });
  const source = Bun.serve({
    port: 0,
    fetch: () => Response.redirect(`http://127.0.0.1:${target.port}/model/info`),
  });
  try {
    expect(
      (await createModelDiscovery()({ ...route, baseURL: `http://127.0.0.1:${source.port}/v1` }))
        .limits,
    ).toBeUndefined();
    expect(received).toBe(0);
  } finally {
    source.stop(true);
    target.stop(true);
  }
});

test("cache and concurrent requests have a fixed process-local bound", async () => {
  let calls = 0;
  const discover = createModelDiscovery({
    fetchImpl: (async () => {
      calls++;
      return Response.json(fixture);
    }) as typeof fetch,
  });
  for (let i = 0; i < 129; i++) await discover({ ...route, key: `synthetic-${i}` });
  await discover({ ...route, key: "synthetic-0" });
  expect(calls).toBe(130);
});
