import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { expectRunOk, registerAgent, runScript } from "./script-helpers";

const EXECUTORS = ["native", "quickjs"] as const;

async function setGlobal(ctx: ScenarioContext, key: string, value: string): Promise<string> {
  const response = await ctx.api("PUT", "/api/config", {
    body: { scope: "global", scopeId: null, key, value, isSecret: false },
  });
  expectStatus(response, [200], `set ${key}`);
  return String(asRecord(response.json).id);
}

/** Applies global config to the API process now, instead of after the debounced auto-reload. */
async function reloadConfig(ctx: ScenarioContext): Promise<void> {
  expectStatus(await ctx.api("POST", "/api/config/reload", { body: {} }), [200], "reload config");
}

// ── ctx.stdlib.retry ──

const RETRY_HELPER_SCRIPT = `export default async function (args: unknown, ctx: any) {
  const retry = ctx.stdlib.retry;
  const fast = { minDelayMs: 5, maxDelayMs: 20 };

  let flakyCalls = 0;
  const value = await retry(async (attempt: number) => {
    flakyCalls++;
    if (attempt < 3) throw new Error("flaky-" + attempt);
    return "ok-" + attempt;
  }, fast);

  let giveUpCalls = 0;
  let lastError = "";
  try {
    await retry(() => {
      giveUpCalls++;
      throw new Error("boom-" + giveUpCalls);
    }, { ...fast, retries: 2 });
  } catch (error: any) {
    lastError = String(error?.message ?? error);
  }

  let transientCalls = 0;
  const transient = await retry(() => {
    transientCalls++;
    return transientCalls < 2 ? { ok: false, status: 503 } : { ok: true, status: 200 };
  }, fast);

  let permanentCalls = 0;
  const permanent = await retry(() => {
    permanentCalls++;
    return { ok: false, status: 400 };
  }, fast);

  let wrappedCalls = 0;
  const double = retry.wrap(async (x: number) => {
    wrappedCalls++;
    if (wrappedCalls < 2) throw new Error("wrapped");
    return x * 2;
  }, fast);
  const wrapped = await double(21);

  let badOption = "";
  try {
    await retry(() => 1, { retries: -1 });
  } catch (error: any) {
    badOption = String(error?.message ?? error);
  }

  return {
    value, flakyCalls, giveUpCalls, lastError, transient, transientCalls,
    permanent, permanentCalls, wrapped, wrappedCalls, badOption,
  };
}`;

/**
 * Flow `script-retry`: ctx.stdlib.retry inside a script run, on both executors. It retries a
 * throw until success, gives up after `retries` with the last error, retries a returned
 * transient status but not a permanent one, wraps a function, and rejects a bad option.
 */
export const scriptRetryHelper: Scenario = {
  name: "script-retry-helper",
  order: 485,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "retry-helper");
    for (const executor of EXECUTORS) {
      const label = `retry helper (${executor})`;
      const run = await runScript(ctx, agentId, {
        source: RETRY_HELPER_SCRIPT,
        executor,
        intent: `e2e retry helper ${executor} ${ctx.nonce}`,
      });
      expectRunOk(run, label);
      const out = asRecord(run.result);
      expect(
        out.value === "ok-3" && out.flakyCalls === 3,
        `${label}: must retry a throw until it succeeds: ${JSON.stringify(out)}`,
      );
      expect(
        out.giveUpCalls === 3 && out.lastError === "boom-3",
        `${label}: must give up after retries + 1 calls with the last error: ${JSON.stringify(out)}`,
      );
      expect(
        asRecord(out.transient).status === 200 && out.transientCalls === 2,
        `${label}: must retry a returned 503: ${JSON.stringify(out)}`,
      );
      expect(
        asRecord(out.permanent).status === 400 && out.permanentCalls === 1,
        `${label}: must not retry a returned 400: ${JSON.stringify(out)}`,
      );
      expect(
        out.wrapped === 42 && out.wrappedCalls === 2,
        `${label}: retry.wrap must retry the wrapped function: ${JSON.stringify(out)}`,
      );
      expect(
        String(out.badOption).includes("retries"),
        `${label}: a negative retries option must be rejected: ${JSON.stringify(out)}`,
      );
    }
  },
};

// ── ctx.stdlib.fetch ──

const FETCH_SCRIPT = `export default async function (args: { base: string }, ctx: any) {
  const out: Record<string, unknown> = {};
  const call = async (name: string, path: string, init: Record<string, unknown>) => {
    const response = await ctx.stdlib.fetch(args.base + path, init);
    out[name] = { status: response.status, body: await response.text() };
  };
  const fast = { minDelayMs: 20, maxDelayMs: 50 };
  await call("get502", "/get-502", { retry: fast });
  await call("put503", "/put-503", { method: "PUT", body: "x", retry: fast });
  await call("get429", "/get-429", {});
  await call("post502", "/post-502", { method: "POST", body: "x", retry: fast });
  await call("post429", "/post-429", { method: "POST", body: "x", retry: fast });
  await call("postKey502", "/post-key-502", {
    method: "POST",
    body: "x",
    retry: { ...fast, idempotencyKey: true },
  });
  await call("noRetry", "/no-retry-502", { retry: false });
  await call("giveUp", "/always-503", { retry: { ...fast, retries: 2 } });
  return out;
}`;

type Hit = { at: number; method: string; idempotencyKey: string | null };

/**
 * A loopback upstream. Each path answers its failure status the first time (every time for
 * `no-retry-*` and `always-*`) and 200 after, and records every hit with its time.
 */
function startFlakyUpstream() {
  const hits = new Map<string, Hit[]>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      const list = hits.get(path) ?? [];
      list.push({
        at: Date.now(),
        method: request.method,
        idempotencyKey: request.headers.get("idempotency-key"),
      });
      hits.set(path, list);
      const name = path.split("/").pop() ?? "";
      const failing =
        name.startsWith("no-retry-") || name.startsWith("always-") || list.length === 1;
      if (!failing) return new Response(`ok ${request.method}`);
      const status = Number(name.match(/(\d{3})$/)?.[1] ?? 500);
      // Retry-After: 1s on the GET, 0s on the POST, so the POST case stays fast.
      const headers: Record<string, string> =
        status === 429 ? { "retry-after": name.startsWith("get") ? "1" : "0" } : {};
      return new Response(`fail ${status}`, { status, headers });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    host: `127.0.0.1:${server.port}`,
    hits: (path: string) => hits.get(path) ?? [],
    stop: () => void server.stop(true),
  };
}

/**
 * Flow `script-retry`: method-aware ctx.stdlib.fetch retries against a loopback upstream, on
 * both executors. GET and PUT retry a 502/503; a 429 retries on every method and waits out
 * Retry-After; a POST without an idempotency key is not retried on a 502; a POST with
 * `idempotencyKey: true` is, with the same key on every attempt; `retry: false` makes one
 * attempt; a persistent 503 gives up after `retries` and returns the last response.
 */
export const scriptRetryFetch: Scenario = {
  name: "script-retry-fetch",
  order: 487,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "retry-fetch");
    const upstream = startFlakyUpstream();
    // quickjs enforces script egress and refuses loopback by default. The operator allowlist
    // admits this one upstream for the scenario, and is removed after it.
    const configId = await setGlobal(ctx, "SCRIPT_EGRESS_ALLOWLIST", upstream.host);
    try {
      await reloadConfig(ctx);
      for (const executor of EXECUTORS) {
        const label = `stdlib.fetch retries (${executor})`;
        const prefix = `/${executor}-${ctx.nonce}`;
        const run = await runScript(ctx, agentId, {
          source: FETCH_SCRIPT,
          args: { base: upstream.origin + prefix },
          executor,
          intent: `e2e fetch retry ${executor} ${ctx.nonce}`,
        });
        expectRunOk(run, label);
        const out = asRecord(run.result);
        const check = (name: string, path: string, status: number, calls: number, what: string) => {
          const got = asRecord(out[name]);
          const seen = upstream.hits(prefix + path).length;
          expect(
            got.status === status && seen === calls,
            `${label}: ${what}: expected status ${status} after ${calls} call(s), got ${got.status} after ${seen}`,
          );
        };
        check("get502", "/get-502", 200, 2, "a GET must retry a 502");
        check("put503", "/put-503", 200, 2, "a PUT must retry a 503");
        check("get429", "/get-429", 200, 2, "a GET must retry a 429");
        check(
          "post502",
          "/post-502",
          502,
          1,
          "a POST without an idempotency key must not retry a 502",
        );
        check("post429", "/post-429", 200, 2, "a POST must retry a 429");
        check(
          "postKey502",
          "/post-key-502",
          200,
          2,
          "a POST with an idempotency key must retry a 502",
        );
        check("noRetry", "/no-retry-502", 502, 1, "retry: false must make one attempt");
        check(
          "giveUp",
          "/always-503",
          503,
          3,
          "a persistent 503 must give up after retries + 1 calls",
        );

        const throttled = upstream.hits(`${prefix}/get-429`);
        const waited = (throttled[1]?.at ?? 0) - (throttled[0]?.at ?? 0);
        expect(
          waited >= 900,
          `${label}: the retry after a 429 must wait Retry-After (1s), waited ${waited}ms`,
        );
        const keyed = upstream.hits(`${prefix}/post-key-502`);
        expect(
          typeof keyed[0]?.idempotencyKey === "string" &&
            keyed[0].idempotencyKey.length > 0 &&
            keyed[1]?.idempotencyKey === keyed[0].idempotencyKey,
          `${label}: every attempt must carry the same Idempotency-Key: ${JSON.stringify(keyed)}`,
        );
      }
    } finally {
      await ctx.api("DELETE", `/api/config/${configId}`);
      await reloadConfig(ctx);
      upstream.stop();
    }
  },
};

// ── ctx.swarm bridge ──

const BRIDGE_SCRIPT = `export default async function (args: { prefix: string }, ctx: any) {
  const key = (marker: string) => args.prefix + marker;
  await ctx.swarm.kv_set({ key: key("-r502"), value: "a" });
  await ctx.swarm.kv_set({ key: key("-r429"), value: "b" });
  const read502 = await ctx.swarm.kv_get({ key: key("-r502") });
  const started = Date.now();
  const read429 = await ctx.swarm.kv_get({ key: key("-r429") });
  const read429Ms = Date.now() - started;
  const write502 = await ctx.swarm.kv_set({ key: key("-w502"), value: "c" });
  const write429 = await ctx.swarm.kv_set({ key: key("-w429"), value: "d" });
  return { read502, read429, read429Ms, write502, write429 };
}`;

/**
 * A loopback proxy in front of the API. The SUT's MCP_BASE_URL points here for the scenario,
 * so script bridge calls pass through it. A KV path whose key ends in a marker fails once:
 * `-r502` / `-r429` on the first GET, `-w502` / `-w429` on the first PUT. The failing request
 * is not forwarded, so a refused write never lands. Everything else is forwarded as is.
 */
function startFaultProxy(target: string) {
  const hits = new Map<string, Array<{ at: number; method: string }>>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const marker = url.pathname.match(/-(r|w)(502|429)$/);
      if (marker) {
        const id = `${request.method} ${url.pathname}`;
        const list = hits.get(id) ?? [];
        list.push({ at: Date.now(), method: request.method });
        hits.set(id, list);
        const failsOn = marker[1] === "r" ? "GET" : "PUT";
        if (request.method === failsOn && list.length === 1) {
          const status = Number(marker[2]);
          // Retry-After 1s on the read, 0s on the write, so the write case stays fast.
          const headers: Record<string, string> =
            status === 429 ? { "retry-after": marker[1] === "r" ? "1" : "0" } : {};
          return Response.json({ error: `injected ${status}` }, { status, headers });
        }
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      const upstream = await fetch(target + url.pathname + url.search, {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.arrayBuffer(),
        redirect: "manual",
      });
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: responseHeaders,
      });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    hits: (method: string, path: string) => hits.get(`${method} ${path}`) ?? [],
    stop: () => void server.stop(true),
  };
}

/**
 * Flow `script-retry`: ctx.swarm bridge calls retry a transient API failure, on both
 * executors. The operator points MCP_BASE_URL at a fault-injecting proxy. A read retries a
 * 502 and waits out a 429's Retry-After; a write is not repeated after a 502 (it may have
 * landed) but is retried after a 429 (refused before any work), and lands once.
 */
export const scriptRetryBridge: Scenario = {
  name: "script-retry-bridge",
  order: 489,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "retry-bridge");
    const proxy = startFaultProxy(ctx.baseUrl.replace(/\/+$/, ""));
    const configId = await setGlobal(ctx, "MCP_BASE_URL", proxy.origin);
    try {
      await reloadConfig(ctx);
      for (const executor of EXECUTORS) {
        const label = `bridge retry (${executor})`;
        const prefix = `bridge-${executor}-${ctx.nonce}`;
        const run = await runScript(ctx, agentId, {
          source: BRIDGE_SCRIPT,
          args: { prefix },
          executor,
          intent: `e2e bridge retry ${executor} ${ctx.nonce}`,
        });
        expectRunOk(run, label);
        const out = asRecord(run.result);
        const path = (marker: string) => `/api/kv/${prefix}${marker}`;
        const calls = (method: string, marker: string) => proxy.hits(method, path(marker)).length;

        const read502 = asRecord(out.read502);
        expect(
          read502.success === true &&
            asRecord(read502.data).value === "a" &&
            calls("GET", "-r502") === 2,
          `${label}: a read must retry a 502: ${JSON.stringify(read502)}, ${calls("GET", "-r502")} call(s)`,
        );
        const read429 = asRecord(out.read429);
        const throttled = proxy.hits("GET", path("-r429"));
        const waited = (throttled[1]?.at ?? 0) - (throttled[0]?.at ?? 0);
        expect(
          read429.success === true &&
            asRecord(read429.data).value === "b" &&
            throttled.length === 2,
          `${label}: a read must retry a 429: ${JSON.stringify(read429)}, ${throttled.length} call(s)`,
        );
        expect(
          waited >= 900 && Number(out.read429Ms) >= 900,
          `${label}: the retry after a 429 must wait Retry-After (1s), waited ${waited}ms`,
        );

        const write502 = asRecord(out.write502);
        expect(
          write502.success === false && write502.status === 502 && calls("PUT", "-w502") === 1,
          `${label}: a write must not repeat after a 502: ${JSON.stringify(write502)}, ${calls("PUT", "-w502")} call(s)`,
        );
        const notWritten = await ctx.api("GET", `/api/kv/${prefix}-w502`, { agentId });
        expectStatus(notWritten, [404], `${label}: the refused write must not land`);

        const write429 = asRecord(out.write429);
        expect(
          write429.success === true && calls("PUT", "-w429") === 2,
          `${label}: a write must retry a 429: ${JSON.stringify(write429)}, ${calls("PUT", "-w429")} call(s)`,
        );
        const written = await ctx.api("GET", `/api/kv/${prefix}-w429`, { agentId });
        expectStatus(written, [200], `${label}: the retried write must land`);
        expect(
          asRecord(written.json).value === "d",
          `${label}: the retried write stored the wrong value`,
        );
      }
    } finally {
      await ctx.api("DELETE", `/api/config/${configId}`);
      await reloadConfig(ctx);
      proxy.stop();
    }
  },
};
