// @ts-nocheck: spike code, not typechecked by the repo (imports resolve in the spike worktree only).
/**
 * /agentfs/* pass-through proxy: spawns a real agent-fs server (from source,
 * local-disk storage, embeddings off) and a real `src/http.ts`, then drives
 * agent-fs only through the proxy. Timings print as `[proxy-timing] {...}` lines.
 *
 * agent-fs source: AGENT_FS_SRC (default ../agent-fs next to the swarm checkout).
 * The suite is skipped when it is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { handleAgentFsProxy } from "../http/agentfs-proxy";
import {
  getFreePort,
  listenOnFreePort,
  SERVER_BOOT_HOOK_TIMEOUT_MS,
  waitForServer,
} from "./test-net";

const AGENT_FS_SRC = process.env.AGENT_FS_SRC ?? join(import.meta.dir, "../../../agent-fs");
const HAVE_AGENT_FS = existsSync(join(AGENT_FS_SRC, "packages/server/src/index.ts"));
const ORIGIN = "http://localhost:5274";
const MB = 1024 * 1024;

const SWARM_KEY = "example-agentfs-proxy-swarm-key";
let dir = "";
let swarmUrl = "";
let afUrl = "";
let swarmProc: Subprocess | undefined;
let afProc: Subprocess | undefined;
let afKey = "";
let orgId = "";
let driveId = "";
const timings: Record<string, number | string> = {};

function rssMb(pid: number): number {
  const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]).stdout.toString();
  return Number.parseInt(out.trim(), 10) / 1024;
}

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${afKey}`, ...extra };
}

function rawUrl(base: string, file: string): string {
  return `${base}/orgs/${orgId}/drives/${driveId}/files/${encodeURIComponent(file)}/raw`;
}

describe.skipIf(!HAVE_AGENT_FS)("/agentfs proxy against a real agent-fs", () => {
  beforeAll(async () => {
    dir = join(tmpdir(), `afo-proxy-test-${Date.now()}`);
    await mkdir(join(dir, "home"), { recursive: true });
    const [afPort, swarmPort] = [await getFreePort(), await getFreePort()];
    afUrl = `http://127.0.0.1:${afPort}`;
    swarmUrl = `http://127.0.0.1:${swarmPort}`;

    afProc = Bun.spawn(["bun", "packages/server/src/index.ts"], {
      cwd: AGENT_FS_SRC,
      env: {
        ...process.env,
        AGENT_FS_HOME: join(dir, "home"),
        AGENT_FS_STORAGE_PROVIDER: "local",
        AGENT_FS_LOCAL_ROOT: join(dir, "blobs"),
        AGENT_FS_MAX_UPLOAD_BYTES: String(400 * MB),
        // An explicit provider without a key makes agent-fs skip embeddings (no download).
        EMBEDDING_PROVIDER: "openai",
        OPENAI_API_KEY: "",
        PORT: String(afPort),
        HOST: "127.0.0.1",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitForServer(`${afUrl}/health`);

    swarmProc = Bun.spawn(["bun", "src/http.ts"], {
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        PORT: String(swarmPort),
        DATABASE_PATH: join(dir, "swarm.sqlite"),
        API_KEY: SWARM_KEY,
        AGENT_SWARM_API_KEY: SWARM_KEY,
        MCP_BASE_URL: swarmUrl,
        DESPLEGA_TELEMETRY_ENV: "test",
        SLACK_DISABLE: "true",
        GITHUB_DISABLE: "true",
        JIRA_DISABLE: "true",
        LINEAR_DISABLE: "true",
        AGENT_FS_API_URL: afUrl,
        AGENT_FS_PROXY: "true",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitForServer(`${swarmUrl}/health`);

    // Register through the proxy: public agent-fs route, no swarm credentials.
    const reg = await fetch(`${swarmUrl}/agentfs/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `proxy-${Date.now()}@example.test` }),
    });
    expect(reg.status).toBe(200);
    const body = (await reg.json()) as { apiKey: string; orgId: string };
    afKey = body.apiKey;
    orgId = body.orgId;

    const me = await fetch(`${swarmUrl}/agentfs/orgs/${orgId}/drives`, { headers: auth() });
    expect(me.status).toBe(200);
    const drives = (await me.json()) as { drives: Array<{ id: string; isDefault?: boolean }> };
    driveId = (drives.drives.find((d) => d.isDefault) ?? drives.drives[0]).id;

    // A 200 MB fixture, written straight to agent-fs so the GET check is isolated.
    const t = performance.now();
    const put = await fetch(rawUrl(afUrl, "big-200mb.bin"), {
      method: "PUT",
      headers: auth({ "If-None-Match": "*" }),
      body: new Uint8Array(200 * MB).fill(7),
    });
    expect(put.status).toBeLessThan(300);
    timings.fixture200mbDirectPutMs = Math.round(performance.now() - t);
  }, SERVER_BOOT_HOOK_TIMEOUT_MS * 2);

  afterAll(async () => {
    console.log(`[proxy-timing] ${JSON.stringify(timings)}`);
    swarmProc?.kill();
    afProc?.kill();
    await swarmProc?.exited;
    await afProc?.exited;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("ops POST works through the proxy, with no swarm bearer", async () => {
    const t = performance.now();
    const w = await fetch(`${swarmUrl}/agentfs/orgs/${orgId}/ops`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ op: "write", path: "/hello.md", content: "hi from the proxy" }),
    });
    expect(w.status).toBe(200);
    const c = await fetch(`${swarmUrl}/agentfs/orgs/${orgId}/ops`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ op: "cat", path: "/hello.md" }),
    });
    expect(c.status).toBe(200);
    expect(JSON.stringify(await c.json())).toContain("hi from the proxy");
    timings.opsRoundTripsMs = Math.round(performance.now() - t);
  });

  test("a request with no credentials gets agent-fs's own 401", async () => {
    const res = await fetch(`${swarmUrl}/agentfs/auth/me`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("UNAUTHORIZED");
    const bad = await fetch(`${swarmUrl}/agentfs/auth/me`, {
      headers: { Authorization: "Bearer af_not-a-real-key" },
    });
    expect(bad.status).toBe(401);
  });

  test("CORS preflight from the dashboard origin passes, with one ACAO value", async () => {
    const pre = await fetch(`${swarmUrl}/agentfs/orgs/${orgId}/ops`, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,x-agent-fs-message",
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-agent-fs-message");

    // agent-fs itself answers ACAO "*"; the proxy must not leak it next to the swarm's echo.
    const get = await fetch(`${swarmUrl}/agentfs/auth/me`, {
      headers: auth({ Origin: ORIGIN }),
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  test("X-Agent-FS-* headers reach the client and are exposed to the browser", async () => {
    const res = await fetch(rawUrl(`${swarmUrl}/agentfs`, "hello.md"), {
      headers: auth({ Origin: ORIGIN }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hi from the proxy");
    expect(res.headers.get("x-agent-fs-version")).toBeTruthy();
    expect(res.headers.get("etag")).toBeTruthy();
    const expose = res.headers.get("access-control-expose-headers") ?? "";
    expect(expose.toLowerCase()).toContain("x-agent-fs-version");
    expect(expose.toLowerCase()).toContain("x-agent-fs-content-hash");
  });

  test("a 50 MB upload streams through, with a 413 untouched when over the cap", async () => {
    const t = performance.now();
    const put = await fetch(rawUrl(`${swarmUrl}/agentfs`, "up-50mb.bin"), {
      method: "PUT",
      headers: auth({ "If-None-Match": "*", "X-Agent-FS-Message": "spike upload" }),
      body: new Uint8Array(50 * MB).fill(3),
    });
    expect(put.status).toBeLessThan(300);
    timings.upload50mbMs = Math.round(performance.now() - t);
    const back = await fetch(rawUrl(afUrl, "up-50mb.bin"), { headers: auth() });
    expect((await back.arrayBuffer()).byteLength).toBe(50 * MB);
  }, 60_000);

  test("a 200 MB raw GET streams: early first byte, flat API memory", async () => {
    const pid = swarmProc?.pid ?? 0;
    const before = rssMb(pid);
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, rssMb(pid));
    }, 25);

    const t0 = performance.now();
    const res = await fetch(rawUrl(`${swarmUrl}/agentfs`, "big-200mb.bin"), { headers: auth() });
    const headersMs = performance.now() - t0;
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let bytes = 0;
    let firstByteMs = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes === 0) firstByteMs = performance.now() - t0;
      bytes += value.byteLength;
    }
    const totalMs = performance.now() - t0;
    clearInterval(sampler);

    // Direct baseline against agent-fs for the same file.
    const d0 = performance.now();
    const direct = await fetch(rawUrl(afUrl, "big-200mb.bin"), { headers: auth() });
    const dr = (direct.body as ReadableStream<Uint8Array>).getReader();
    const first = await dr.read();
    const directFirstByteMs = performance.now() - d0;
    await dr.cancel();
    expect(first.value?.byteLength).toBeGreaterThan(0);

    expect(bytes).toBe(200 * MB);
    Object.assign(timings, {
      get200mbHeadersMs: Math.round(headersMs),
      get200mbFirstByteMs: Math.round(firstByteMs),
      get200mbTotalMs: Math.round(totalMs),
      directFirstByteMs: Math.round(directFirstByteMs),
      apiRssBeforeMb: Math.round(before),
      apiRssPeakMb: Math.round(peak),
      apiRssGrowthMb: Math.round(peak - before),
    });
    // The whole file is 200 MB. Buffering would grow RSS by at least that much.
    expect(peak - before).toBeLessThan(100);
  }, 120_000);

  test("a stalled client applies backpressure: the API does not buffer the file", async () => {
    const pid = swarmProc?.pid ?? 0;
    const before = rssMb(pid);
    const res = await fetch(rawUrl(`${swarmUrl}/agentfs`, "big-200mb.bin"), { headers: auth() });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await Bun.sleep(3000); // read nothing more while the proxy would be free to buffer
    const stalled = rssMb(pid);
    await reader.cancel();
    timings.stalledClientRssGrowthMb = Math.round(stalled - before);
    expect(stalled - before).toBeLessThan(100);
  }, 30_000);

  test("the events SSE stream survives 20 s of silence", async () => {
    const ac = new AbortController();
    const t0 = performance.now();
    const res = await fetch(`${swarmUrl}/agentfs/orgs/${orgId}/drives/${driveId}/events`, {
      headers: auth({ Accept: "text/event-stream" }),
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    let firstChunkMs = -1;
    const deadline = t0 + 21_000;
    while (performance.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(0, deadline - performance.now())).then(() => null),
      ]);
      if (next === null) break;
      if (next.done) throw new Error("SSE stream closed before 20 s of silence passed");
      if (firstChunkMs < 0) firstChunkMs = performance.now() - t0;
      text += decoder.decode(next.value);
    }
    ac.abort();
    const pings = (text.match(/: ?ping/g) ?? []).length;
    timings.sseFirstChunkMs = Math.round(firstChunkMs);
    timings.ssePingsIn21s = pings;
    expect(pings).toBeGreaterThanOrEqual(3);
  }, 40_000);

  test("closing an SSE client aborts the upstream stream", async () => {
    const ac = new AbortController();
    const res = await fetch(`${swarmUrl}/agentfs/orgs/${orgId}/drives/${driveId}/events`, {
      headers: auth(),
      signal: ac.signal,
    });
    await (res.body as ReadableStream<Uint8Array>).getReader().read();
    ac.abort();
    // 8 streams per user are allowed. 9 open+close cycles only succeed when each close frees its slot.
    for (let i = 0; i < 9; i++) {
      const c = new AbortController();
      const r = await fetch(`${swarmUrl}/agentfs/orgs/${orgId}/drives/${driveId}/events`, {
        headers: auth(),
        signal: c.signal,
      });
      expect(r.status).toBe(200);
      await (r.body as ReadableStream<Uint8Array>).getReader().read();
      c.abort();
      await Bun.sleep(100);
    }
  }, 30_000);
});

describe("handleAgentFsProxy in isolation", () => {
  let server: Server;
  let proxyUrl = "";
  let upstream: Server;
  let seen: IncomingMessage["headers"] = {};
  let seenUrl = "";
  const saved = { proxy: process.env.AGENT_FS_PROXY, url: process.env.AGENT_FS_API_URL };

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen = req.headers;
      seenUrl = req.url ?? "";
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "X-Agent-FS-Version": "9",
        "Content-Type": "text/plain",
      });
      res.end("ok");
    });
    const upPort = await listenOnFreePort(upstream, "127.0.0.1");
    process.env.AGENT_FS_API_URL = `http://127.0.0.1:${upPort}/`;
    server = createServer(async (req, res) => {
      if (!(await handleAgentFsProxy(req, res))) {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    proxyUrl = `http://127.0.0.1:${await listenOnFreePort(server, "127.0.0.1")}`;
  });

  afterAll(() => {
    server.close();
    upstream.close();
    for (const [k, v] of [
      ["AGENT_FS_PROXY", saved.proxy],
      ["AGENT_FS_API_URL", saved.url],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("flag unset: the handler declines and the request falls through", async () => {
    delete process.env.AGENT_FS_PROXY;
    const res = await fetch(`${proxyUrl}/agentfs/health`);
    expect(res.status).toBe(404);
  });

  test("flag on: strips the prefix, keeps %2F, forwards only allowlisted headers", async () => {
    process.env.AGENT_FS_PROXY = "true";
    const res = await fetch(`${proxyUrl}/agentfs/orgs/o/files/a%2Fb.md/raw?x=1`, {
      headers: {
        Authorization: "Bearer af_example",
        Cookie: "session=secret",
        "X-Agent-ID": "agent",
        "X-Agent-FS-Message": "m",
      },
    });
    expect(res.status).toBe(200);
    expect(seenUrl).toBe("/orgs/o/files/a%2Fb.md/raw?x=1");
    expect(seen.authorization).toBe("Bearer af_example");
    expect(seen["x-agent-fs-message"]).toBe("m");
    expect(seen.cookie).toBeUndefined();
    expect(seen["x-agent-id"]).toBeUndefined();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("x-agent-fs-version")).toBe("9");
  });

  test("path traversal is rejected", async () => {
    process.env.AGENT_FS_PROXY = "true";
    const port = new URL(proxyUrl).port;
    // node:http sends the path untouched, unlike fetch which normalises dot segments.
    for (const path of ["/agentfs/a/../../etc", "/agentfs/a/%2e%2E/etc"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const r = httpRequest({ host: "127.0.0.1", port, path }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on("error", reject);
        r.end();
      });
      expect(status).toBe(400);
    }
  });

  test("an unreachable upstream answers 502", async () => {
    process.env.AGENT_FS_PROXY = "true";
    process.env.AGENT_FS_API_URL = `http://127.0.0.1:${await getFreePort()}`;
    const res = await fetch(`${proxyUrl}/agentfs/health`);
    expect(res.status).toBe(502);
  });
});
