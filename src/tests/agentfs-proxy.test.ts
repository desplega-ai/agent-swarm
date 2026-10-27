/**
 * /agentfs/* pass-through proxy: spawns a real agent-fs server (from source,
 * local-disk storage, embeddings off) and a real `src/http.ts`, then drives
 * agent-fs only through the proxy. Timings print as `[proxy-timing] {...}` lines.
 *
 * agent-fs source: AGENT_FS_SRC (default ../agent-fs next to the swarm checkout).
 * That suite is skipped when the checkout or its node_modules is missing (CI has none). The suites after it
 * use an in-process fake agent-fs and always run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { closeDb, createUser, initDb } from "../be/db";
import { mintToken } from "../be/users";
import { _resetAgentFsRegisterRateLimitForTests, handleAgentFsProxy } from "../http/agentfs-proxy";
import { setCorsHeaders } from "../http/utils";
import {
  getFreePort,
  listenOnFreePort,
  PORT_IN_USE_LOG,
  PortInUseError,
  SERVER_BOOT_HOOK_TIMEOUT_MS,
  startOnFreePort,
  waitForServer,
} from "./test-net";
import { runChild } from "./test-proc";

const AGENT_FS_SRC = process.env.AGENT_FS_SRC ?? join(import.meta.dir, "../../../agent-fs");
const HAVE_AGENT_FS =
  existsSync(join(AGENT_FS_SRC, "packages/server/src/index.ts")) &&
  existsSync(join(AGENT_FS_SRC, "node_modules"));
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

async function rssMb(pid: number): Promise<number> {
  const out = (await runChild(["ps", "-o", "rss=", "-p", String(pid)], { timeoutMs: 5000 })).stdout;
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

    // Register through the proxy: it needs a swarm credential (the operator key here).
    const reg = await fetch(`${swarmUrl}/agentfs/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SWARM_KEY}` },
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

  // Runs first, on a fresh API process: buffering the file would grow RSS by its size.
  test("a stalled client applies backpressure: the API does not buffer the file", async () => {
    const pid = swarmProc?.pid ?? 0;
    const before = await rssMb(pid);
    const res = await fetch(rawUrl(`${swarmUrl}/agentfs`, "big-200mb.bin"), { headers: auth() });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await Bun.sleep(3000); // read nothing more while the proxy would be free to buffer
    const stalled = await rssMb(pid);
    await reader.cancel();
    timings.stalledClientRssGrowthMb = Math.round(stalled - before);
    expect(stalled - before).toBeLessThan(100);
  }, 30_000);

  test("a 200 MB raw GET streams: early first byte, no memory kept per download", async () => {
    const pid = swarmProc?.pid ?? 0;
    const readAll = async () => {
      const t0 = performance.now();
      const res = await fetch(rawUrl(`${swarmUrl}/agentfs`, "big-200mb.bin"), {
        headers: auth(),
      });
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
      return { bytes, headersMs, firstByteMs, totalMs: performance.now() - t0 };
    };
    const before = await rssMb(pid);
    let peak = before;
    const sampler = setInterval(() => {
      void rssMb(pid).then((mb) => {
        peak = Math.max(peak, mb);
      });
    }, 25);
    const run1 = await readAll();
    const peak1 = peak;
    const run2 = await readAll();
    await Bun.sleep(100);
    clearInterval(sampler);

    // Direct baseline against agent-fs for the same file.
    const d0 = performance.now();
    const direct = await fetch(rawUrl(afUrl, "big-200mb.bin"), { headers: auth() });
    const dr = (direct.body as ReadableStream<Uint8Array>).getReader();
    const first = await dr.read();
    const directFirstByteMs = performance.now() - d0;
    await dr.cancel();
    expect(first.value?.byteLength).toBeGreaterThan(0);

    expect(run1.bytes).toBe(200 * MB);
    expect(run2.bytes).toBe(200 * MB);
    Object.assign(timings, {
      get200mbHeadersMs: Math.round(run1.headersMs),
      get200mbFirstByteMs: Math.round(run1.firstByteMs),
      get200mbTotalMs: Math.round(run1.totalMs),
      directFirstByteMs: Math.round(directFirstByteMs),
      apiRssBeforeMb: Math.round(before),
      apiRssPeakMb: Math.round(peak1),
      apiRssGrowthMb: Math.round(peak1 - before),
      apiRssSecondDownloadGrowthMb: Math.round(peak - peak1),
    });
    // A fast reader can raise RSS by up to the file size before the GC catches up
    // (seen on Linux, not on macOS). A copy the proxy kept would add the whole
    // 200 MB again on the second download, so stay well under the file size; the
    // stalled-client test above is the buffering check.
    expect(peak - peak1).toBeLessThan(150);
  }, 120_000);

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

// ─── CI-safe tests: a fake agent-fs (Bun.serve on port 0), no checkout needed ───

interface FakeAgentFs {
  url: string;
  /** Headers and URL of the last request the fake saw. */
  last: { url: string; headers: Headers; method: string } | null;
  /** The body of the last POST /auth/register. */
  registerBody: string | null;
  hits: number;
  /** performance.now() when the fake wrote the last byte of /big. */
  bigDoneAt: number;
  /** Set when an /events stream was closed from the proxy side. */
  sseClosed: boolean;
  stop(): void;
}

const FAKE_SHARE_TOKEN = "tok_fake_share_secret_0123456789";
/** The swarm key in the fake-agent-fs suites (register through the proxy needs one). */
const FAKE_SWARM_KEY = "example-agentfs-proxy-fake-swarm-key";

function startFakeAgentFs(): FakeAgentFs {
  const fake: FakeAgentFs = {
    url: "",
    last: null,
    registerBody: null,
    hits: 0,
    bigDoneAt: 0,
    sseClosed: false,
    stop: () => {},
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(request) {
      const url = new URL(request.url);
      fake.hits++;
      fake.last = {
        url: url.pathname + url.search,
        headers: new Headers(request.headers),
        method: request.method,
      };
      if (url.pathname === "/auth/register" && request.method === "POST") {
        return request.text().then((text) => {
          fake.registerBody = text;
          return Response.json({ apiKey: "af_new", orgId: "org-1" });
        });
      }
      if (url.pathname === "/big") {
        // 20 x 1 MB chunks, 15 ms apart: the upstream needs about 300 ms to finish.
        const total = Number(url.searchParams.get("mb") ?? "20");
        let sent = 0;
        const chunk = new Uint8Array(MB).fill(5);
        return new Response(
          new ReadableStream({
            async pull(controller) {
              if (sent >= total) {
                fake.bigDoneAt = performance.now();
                controller.close();
                return;
              }
              if (sent > 0) await Bun.sleep(15);
              controller.enqueue(chunk);
              sent++;
            },
          }),
          { headers: { "Content-Type": "application/octet-stream" } },
        );
      }
      if (url.pathname === "/events") {
        const interval = Number(url.searchParams.get("interval") ?? "200");
        let timer: ReturnType<typeof setInterval> | undefined;
        const close = () => {
          if (timer) clearInterval(timer);
          fake.sseClosed = true;
        };
        request.signal.addEventListener("abort", close);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": ping\n\n"));
              timer = setInterval(() => {
                try {
                  controller.enqueue(new TextEncoder().encode(": ping\n\n"));
                } catch {
                  close();
                }
              }, interval);
            },
            cancel: close,
          }),
          { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
        );
      }
      if (url.pathname.startsWith("/share/") || url.pathname.startsWith("/site/")) {
        return new Response("<html>shared</html>", {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Content-Security-Policy": "sandbox allow-scripts; frame-ancestors *",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      return new Response("ok", {
        headers: {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
          "X-Agent-FS-Version": "9",
          "Set-Cookie": "af=1",
          "X-Upstream-Internal": "secret",
        },
      });
    },
  });
  fake.url = `http://127.0.0.1:${server.port}`;
  fake.stop = () => server.stop(true);
  return fake;
}

async function rawStatus(base: string, path: string): Promise<number> {
  const { port, hostname } = new URL(base);
  return new Promise<number>((resolve, reject) => {
    // node:http sends the path untouched, unlike fetch which normalises dot segments.
    const r = httpRequest({ host: hostname, port, path }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end();
  });
}

/** A POST with the path sent byte for byte (fetch would resolve `.` and `\\`), with the operator key. */
async function rawPostStatus(base: string, path: string, ip: string): Promise<number> {
  const { port, hostname } = new URL(base);
  const body = JSON.stringify({ email: "a@example.test" });
  return new Promise<number>((resolve, reject) => {
    const r = httpRequest(
      {
        host: hostname,
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Forwarded-For": ip,
          Authorization: `Bearer ${FAKE_SWARM_KEY}`,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    r.on("error", reject);
    r.end(body);
  });
}

describe("handleAgentFsProxy against a fake agent-fs", () => {
  let fake: FakeAgentFs;
  let server: Server;
  let proxyUrl = "";
  const saved = {
    proxy: process.env.AGENT_FS_PROXY,
    url: process.env.AGENT_FS_API_URL,
    key: process.env.AGENT_SWARM_API_KEY,
  };

  beforeAll(async () => {
    process.env.AGENT_SWARM_API_KEY = FAKE_SWARM_KEY;
    fake = startFakeAgentFs();
    process.env.AGENT_FS_API_URL = `${fake.url}/`;
    // Same order as the real pipeline: the swarm's CORS first, then the proxy.
    server = createServer(async (req, res) => {
      setCorsHeaders(req, res);
      if (!(await handleAgentFsProxy(req, res))) {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    proxyUrl = `http://127.0.0.1:${await listenOnFreePort(server, "127.0.0.1")}`;
  });

  beforeEach(() => {
    process.env.AGENT_FS_PROXY = "true";
    process.env.AGENT_FS_API_URL = `${fake.url}/`;
    _resetAgentFsRegisterRateLimitForTests();
  });

  afterAll(() => {
    server.close();
    fake.stop();
    for (const [k, v] of [
      ["AGENT_FS_PROXY", saved.proxy],
      ["AGENT_FS_API_URL", saved.url],
      ["AGENT_SWARM_API_KEY", saved.key],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("flag unset or off: the handler declines on every prefix", async () => {
    for (const value of [undefined, "false", "0"]) {
      if (value === undefined) delete process.env.AGENT_FS_PROXY;
      else process.env.AGENT_FS_PROXY = value;
      const before = fake.hits;
      for (const path of ["/agentfs/health", "/share/x", "/site/x"]) {
        expect((await fetch(`${proxyUrl}${path}`)).status).toBe(404);
      }
      expect(fake.hits).toBe(before);
    }
  });

  test("every boolean literal the config validator accepts turns it on", async () => {
    for (const value of ["true", " TRUE ", "1"]) {
      process.env.AGENT_FS_PROXY = value;
      expect((await fetch(`${proxyUrl}/agentfs/health`)).status).toBe(200);
    }
  });

  test("strips the prefix, keeps %2F, forwards only allowlisted headers", async () => {
    const res = await fetch(`${proxyUrl}/agentfs/orgs/o/files/a%2Fb.md/raw?x=1`, {
      headers: {
        Authorization: "Bearer af_example",
        Cookie: "session=secret",
        "X-Agent-ID": "agent",
        "X-Agent-FS-Message": "m",
        "X-Agent-FS-Message-Encoding": "base64",
        "If-Match": '"v1"',
        Range: "bytes=0-1",
        "X-Swarm-User-Id": "user",
      },
    });
    expect(res.status).toBe(200);
    expect(fake.last?.url).toBe("/orgs/o/files/a%2Fb.md/raw?x=1");
    const seen = fake.last?.headers ?? new Headers();
    expect(seen.get("authorization")).toBe("Bearer af_example");
    expect(seen.get("x-agent-fs-message")).toBe("m");
    expect(seen.get("x-agent-fs-message-encoding")).toBe("base64");
    expect(seen.get("if-match")).toBe('"v1"');
    expect(seen.get("range")).toBe("bytes=0-1");
    expect(seen.get("cookie")).toBeNull();
    expect(seen.get("x-agent-id")).toBeNull();
    expect(seen.get("x-swarm-user-id")).toBeNull();
    // Response: upstream CORS, Set-Cookie and unknown headers dropped; x-agent-fs-* kept.
    expect(res.headers.get("access-control-allow-origin")).toBe("*"); // the swarm's own no-Origin answer
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-upstream-internal")).toBeNull();
    expect(res.headers.get("x-agent-fs-version")).toBe("9");
  });

  test("a swarm API key or an aswt_ token never reaches agent-fs", async () => {
    for (const value of ["Bearer aswt_example-user-token", "Bearer 123123", "Basic YTpi", "af_x"]) {
      const res = await fetch(`${proxyUrl}/agentfs/auth/me`, {
        headers: { Authorization: value },
      });
      expect(res.status).toBe(200);
      expect(fake.last?.headers.get("authorization")).toBeNull();
    }
  });

  test("upstream CORS is replaced by the swarm's on /agentfs", async () => {
    const res = await fetch(`${proxyUrl}/agentfs/auth/me`, {
      headers: { Origin: ORIGIN, Authorization: "Bearer af_example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-expose-headers")?.toLowerCase()).toContain(
      "x-agent-fs-version",
    );
  });

  test("a 20 MB body streams: the first chunk arrives before the upstream finishes", async () => {
    fake.bigDoneAt = 0;
    const res = await fetch(`${proxyUrl}/agentfs/big?mb=20`);
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    const firstAt = performance.now();
    expect(first.value?.byteLength).toBeGreaterThan(0);
    let bytes = first.value?.byteLength ?? 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    expect(bytes).toBe(20 * MB);
    expect(fake.bigDoneAt).toBeGreaterThan(0);
    expect(firstAt).toBeLessThan(fake.bigDoneAt);
  }, 30_000);

  test("SSE pings keep the stream open for 2 s, and a client abort closes the upstream", async () => {
    fake.sseClosed = false;
    const ac = new AbortController();
    const res = await fetch(`${proxyUrl}/agentfs/events?interval=200`, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(0, deadline - performance.now())).then(() => null),
      ]);
      if (next === null) break;
      if (next.done) throw new Error("SSE stream closed before 2 s passed");
      text += decoder.decode(next.value);
    }
    expect((text.match(/: ping/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(fake.sseClosed).toBe(false);
    ac.abort();
    const closeDeadline = performance.now() + 3000;
    while (!fake.sseClosed && performance.now() < closeDeadline) await Bun.sleep(25);
    expect(fake.sseClosed).toBe(true);
  }, 15_000);

  test("/site/<token>/ with Origin: null keeps agent-fs's Access-Control-Allow-Origin: *", async () => {
    const res = await fetch(`${proxyUrl}/site/${FAKE_SHARE_TOKEN}/`, {
      headers: { Origin: "null" },
    });
    expect(res.status).toBe(200);
    expect(fake.last?.url).toBe(`/site/${FAKE_SHARE_TOKEN}/`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("/share/<token>/raw from an allowlisted origin still gets agent-fs's CORS, not the swarm's", async () => {
    const res = await fetch(`${proxyUrl}/share/${FAKE_SHARE_TOKEN}/raw`, {
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(fake.last?.url).toBe(`/share/${FAKE_SHARE_TOKEN}/raw`);
    expect(await res.text()).toContain("shared");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("/share and /site accept GET only", async () => {
    const res = await fetch(`${proxyUrl}/share/${FAKE_SHARE_TOKEN}`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("encoded and doubled-slash register paths share the same per-IP limit", async () => {
    const paths = [
      "/agentfs/auth/%72egister",
      "/agentfs//auth/register",
      "/agentfs/auth/register/",
      "/agentfs/auth%2Fregister",
      "/agentfs/auth/register",
    ];
    for (const path of paths) {
      const res = await fetch(`${proxyUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.9",
          Authorization: `Bearer ${FAKE_SWARM_KEY}`,
        },
        body: JSON.stringify({ email: "a@example.test" }),
      });
      expect({ path, limited: res.status === 429 }).toEqual({ path, limited: false });
    }
    const sixth = await fetch(`${proxyUrl}/agentfs/auth/%72egister`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.9",
        Authorization: `Bearer ${FAKE_SWARM_KEY}`,
      },
      body: JSON.stringify({ email: "a@example.test" }),
    });
    expect(sixth.status).toBe(429);
  });

  test("dot-segment and backslash register paths are rejected, not passed upstream", async () => {
    const ip = "203.0.113.10";
    for (const path of [
      "/agentfs/./auth/register",
      "/agentfs/auth/./register",
      "/agentfs/%2e/auth/register",
      "/agentfs/auth%2F.%2Fregister",
      "/agentfs/auth\\register",
      "/agentfs/auth%5Cregister",
    ]) {
      fake.last = null;
      // Seven tries: on the old code each one reached upstream /auth/register unlimited.
      for (let i = 0; i < 7; i++) {
        expect({ path, status: await rawPostStatus(proxyUrl, path, ip) }).toEqual({
          path,
          status: 400,
        });
      }
      expect(fake.last).toBeNull();
    }
    // The canonical path still has its full bucket of five.
    for (let i = 0; i < 5; i++) {
      expect(await rawPostStatus(proxyUrl, "/agentfs/auth/register", ip)).toBe(200);
    }
    expect(await rawPostStatus(proxyUrl, "/agentfs/auth/register", ip)).toBe(429);
  });

  test("a raw #fragment on the register path still hits the register limit", async () => {
    for (const [path, ip] of [
      ["/agentfs/auth/register#x", "203.0.113.11"],
      ["/agentfs/auth/register?a=1#x", "203.0.113.12"],
    ] as const) {
      // fetch() drops the fragment, so these reach upstream /auth/register.
      for (let i = 0; i < 5; i++) {
        expect({ path, status: await rawPostStatus(proxyUrl, path, ip) }).toEqual({
          path,
          status: 200,
        });
        expect(fake.last?.url.split("?")[0]).toBe("/auth/register");
      }
      for (let i = 0; i < 2; i++) {
        fake.last = null;
        expect({ path, status: await rawPostStatus(proxyUrl, path, ip) }).toEqual({
          path,
          status: 429,
        });
        expect(fake.last).toBeNull();
      }
    }
  });

  test("the sixth POST /agentfs/auth/register from one IP within a minute gets 429", async () => {
    const register = (ip: string) =>
      fetch(`${proxyUrl}/agentfs/auth/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": ip,
          Authorization: `Bearer ${FAKE_SWARM_KEY}`,
        },
        body: JSON.stringify({ email: "a@example.test" }),
      });
    for (let i = 0; i < 5; i++) expect((await register("203.0.113.7")).status).toBe(200);
    const sixth = await register("203.0.113.7");
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toBeTruthy();
    // Another IP has its own bucket, and other agent-fs routes are not limited.
    expect((await register("203.0.113.8")).status).toBe(200);
    expect(
      (
        await fetch(`${proxyUrl}/agentfs/auth/me`, {
          headers: { "X-Forwarded-For": "203.0.113.7" },
        })
      ).status,
    ).toBe(200);
  });

  test("path traversal is rejected on every prefix", async () => {
    for (const path of [
      "/agentfs/a/../../etc",
      "/agentfs/a/%2e%2E/etc",
      "/share/t/../../etc",
      "/site/t/%2E%2e/x",
      "/agentfs/auth/%2e./register",
      "/share/t/./raw",
      "/site/t\\x",
    ]) {
      expect(await rawStatus(proxyUrl, path)).toBe(400);
    }
  });

  test("an unreachable upstream answers 502", async () => {
    process.env.AGENT_FS_API_URL = `http://127.0.0.1:${await getFreePort()}`;
    expect((await fetch(`${proxyUrl}/agentfs/health`)).status).toBe(502);
    expect((await fetch(`${proxyUrl}/share/${FAKE_SHARE_TOKEN}`)).status).toBe(502);
  });
});

// ─── The real API (src/http.ts) in front of the fake agent-fs ───

interface SwarmChild {
  url: string;
  proc: Subprocess;
  log: () => string;
}

async function startSwarm(env: Record<string, string>, dbDir: string): Promise<SwarmChild> {
  return startOnFreePort(async (port) => {
    const url = `http://127.0.0.1:${port}`;
    const proc = Bun.spawn(["bun", "src/http.ts"], {
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_PATH: join(dbDir, "swarm.sqlite"),
        API_KEY: SWARM_KEY,
        AGENT_SWARM_API_KEY: SWARM_KEY,
        MCP_BASE_URL: url,
        DESPLEGA_TELEMETRY_ENV: "test",
        SLACK_DISABLE: "true",
        GITHUB_DISABLE: "true",
        JIRA_DISABLE: "true",
        LINEAR_DISABLE: "true",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) out += decoder.decode(chunk);
    };
    void drain(proc.stdout as ReadableStream<Uint8Array>);
    void drain(proc.stderr as ReadableStream<Uint8Array>);
    try {
      await waitForServer(`${url}/health`);
    } catch (error) {
      proc.kill();
      if (PORT_IN_USE_LOG.test(out)) throw new PortInUseError(out);
      throw error;
    }
    return { url, proc, log: () => out };
  });
}

describe("the API in front of a fake agent-fs", () => {
  let fake: FakeAgentFs;
  let on: SwarmChild;
  let off: SwarmChild;
  let tmp = "";

  beforeAll(async () => {
    fake = startFakeAgentFs();
    tmp = join(tmpdir(), `afo-proxy-fake-${Date.now()}-${process.pid}`);
    await mkdir(join(tmp, "on"), { recursive: true });
    await mkdir(join(tmp, "off"), { recursive: true });
    [on, off] = await Promise.all([
      startSwarm({ AGENT_FS_API_URL: fake.url, AGENT_FS_PROXY: "true" }, join(tmp, "on")),
      startSwarm({ AGENT_FS_API_URL: fake.url }, join(tmp, "off")),
    ]);
  }, SERVER_BOOT_HOOK_TIMEOUT_MS * 2);

  afterAll(async () => {
    on?.proc.kill();
    off?.proc.kill();
    await on?.proc.exited;
    await off?.proc.exited;
    fake.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("CORS preflight from the dashboard origin returns 204 with one ACAO", async () => {
    const pre = await fetch(`${on.url}/agentfs/orgs/o/ops`, {
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

    const get = await fetch(`${on.url}/agentfs/auth/me`, {
      headers: { Origin: ORIGIN, Authorization: "Bearer af_example" },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  test("no swarm credential is needed, and the swarm API key is not forwarded", async () => {
    expect((await fetch(`${on.url}/agentfs/auth/me`)).status).toBe(200);
    const res = await fetch(`${on.url}/agentfs/auth/me`, {
      headers: { Authorization: `Bearer ${SWARM_KEY}`, "X-Agent-ID": "agent" },
    });
    expect(res.status).toBe(200);
    expect(fake.last?.headers.get("authorization")).toBeNull();
    expect(fake.last?.headers.get("x-agent-id")).toBeNull();
  });

  test("/share/<token>/raw forwards, and the access log line does not contain the token", async () => {
    const res = await fetch(`${on.url}/share/${FAKE_SHARE_TOKEN}/raw`);
    expect(res.status).toBe(200);
    expect(fake.last?.url).toBe(`/share/${FAKE_SHARE_TOKEN}/raw`);
    const deadline = performance.now() + 5000;
    while (!on.log().includes("/share/[REDACTED]/raw") && performance.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(on.log()).toContain("GET /share/[REDACTED]/raw → 200");
    expect(on.log()).not.toContain(FAKE_SHARE_TOKEN);
  });

  test("flag off: authenticated /agentfs, /share and /site keep today's 404", async () => {
    const before = fake.hits;
    for (const path of ["/agentfs/x", "/agentfs/health", "/share/x", "/site/x"]) {
      const res = await fetch(`${off.url}${path}`, {
        headers: { Authorization: `Bearer ${SWARM_KEY}` },
      });
      expect(res.status).toBe(404);
    }
    expect(fake.hits).toBe(before);
  });

  test("flag off: unauthenticated requests now get 404, not 401 (accepted change)", async () => {
    for (const path of ["/agentfs/x", "/share/x", "/site/x"]) {
      expect((await fetch(`${off.url}${path}`)).status).toBe(404);
    }
  });
});

describe("POST /agentfs/auth/register needs a swarm credential", () => {
  let fake: FakeAgentFs;
  let server: Server;
  let proxyUrl = "";
  let userToken = "";
  const saved = {
    proxy: process.env.AGENT_FS_PROXY,
    url: process.env.AGENT_FS_API_URL,
    key: process.env.AGENT_SWARM_API_KEY,
  };

  beforeAll(async () => {
    process.env.AGENT_SWARM_API_KEY = FAKE_SWARM_KEY;
    initDb(":memory:");
    const user = await createUser({
      name: "Proxy teammate",
      email: "Mate@Example.test",
      emailAliases: ["mate.alias@example.test"],
    });
    const actor = { kind: "operator", id: "agentfs-proxy-test" } as const;
    userToken = (await mintToken(user.id, "agentfs-proxy-test", actor)).plaintext;
    fake = startFakeAgentFs();
    server = createServer(async (req, res) => {
      if (!(await handleAgentFsProxy(req, res))) {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    proxyUrl = `http://127.0.0.1:${await listenOnFreePort(server, "127.0.0.1")}`;
  });

  beforeEach(() => {
    process.env.AGENT_FS_PROXY = "true";
    process.env.AGENT_FS_API_URL = fake.url;
    _resetAgentFsRegisterRateLimitForTests();
    fake.registerBody = null;
  });

  afterAll(() => {
    server.close();
    fake.stop();
    closeDb();
    for (const [k, v] of [
      ["AGENT_FS_PROXY", saved.proxy],
      ["AGENT_FS_API_URL", saved.url],
      ["AGENT_SWARM_API_KEY", saved.key],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const register = (body: unknown, authorization?: string) =>
    fetch(`${proxyUrl}/agentfs/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("no credential, an af_ key, a wrong key or an unknown user token: 401, never upstream", async () => {
    for (const authorization of [
      undefined,
      "Bearer af_someone",
      "Bearer not-the-swarm-key",
      "Bearer aswt_unknown",
    ]) {
      const res = await register({ email: "mate@example.test" }, authorization);
      expect({ authorization, status: res.status }).toEqual({ authorization, status: 401 });
    }
    expect(fake.registerBody).toBeNull();
  });

  test("the operator key registers any email, and no swarm bearer goes upstream", async () => {
    const res = await register({ email: "someone@example.test" }, `Bearer ${FAKE_SWARM_KEY}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(fake.registerBody ?? "null")).toEqual({ email: "someone@example.test" });
    expect(fake.last?.headers.get("authorization")).toBeNull();
  });

  test("a swarm key shaped like an agent-fs key never goes upstream", async () => {
    const afShaped = "af_example-swarm-operator-key"; // gitleaks:allow (test fixture, not a real key)
    process.env.AGENT_SWARM_API_KEY = afShaped;
    try {
      const res = await register({ email: "someone@example.test" }, `Bearer ${afShaped}`);
      expect(res.status).toBe(200);
      expect(fake.last?.headers.get("authorization")).toBeNull();

      await fetch(`${proxyUrl}/agentfs/auth/me`, {
        headers: { Authorization: `Bearer ${afShaped}` },
      });
      expect(fake.last?.url).toBe("/auth/me");
      expect(fake.last?.headers.get("authorization")).toBeNull();

      // A teammate's own agent-fs key still goes upstream.
      await fetch(`${proxyUrl}/agentfs/auth/me`, { headers: { Authorization: "Bearer af_mate" } });
      expect(fake.last?.headers.get("authorization")).toBe("Bearer af_mate");
    } finally {
      process.env.AGENT_SWARM_API_KEY = FAKE_SWARM_KEY;
    }
  });

  test("a user token registers its own email or an alias, not a teammate's", async () => {
    for (const email of ["MATE@example.test", "mate.alias@example.test"]) {
      const res = await register({ email }, `Bearer ${userToken}`);
      expect({ email, status: res.status }).toEqual({ email, status: 200 });
    }
    fake.registerBody = null;
    const other = await register({ email: "lead@example.test" }, `Bearer ${userToken}`);
    expect(other.status).toBe(403);
    const noEmail = await register({}, `Bearer ${userToken}`);
    expect(noEmail.status).toBe(403);
    expect(fake.registerBody).toBeNull();
  });

  test("agent-fs reads the same email the proxy checked, even with a repeated key", async () => {
    // JSON.parse keeps the last key. The proxy sends the parsed body again.
    const taken = await register(
      '{"email":"mate@example.test","email":"lead@example.test"}',
      `Bearer ${userToken}`,
    );
    expect(taken.status).toBe(403);
    const own = await register(
      '{"email":"lead@example.test","email":"mate@example.test"}',
      `Bearer ${userToken}`,
    );
    expect(own.status).toBe(200);
    expect(JSON.parse(fake.registerBody ?? "null")).toEqual({ email: "mate@example.test" });
  });

  test("a body over 16 KB gets 413, and bad JSON gets 400", async () => {
    const big = await register(
      { email: "a@example.test", pad: "x".repeat(17_000) },
      `Bearer ${FAKE_SWARM_KEY}`,
    );
    expect(big.status).toBe(413);
    const bad = await register("{not json", `Bearer ${FAKE_SWARM_KEY}`);
    expect(bad.status).toBe(400);
    expect(fake.registerBody).toBeNull();
  });
});
