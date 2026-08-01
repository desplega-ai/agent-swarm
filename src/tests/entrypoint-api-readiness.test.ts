import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Regression tests for the `wait_for_api_ready` bounded /health poll in
 * docker-entrypoint.sh (Phase 2 of the baked-skills-to-db-seeding plan:
 * "Gate Worker Boot on API Readiness").
 *
 * The function is extracted verbatim from docker-entrypoint.sh between its
 * `# BEGIN wait_for_api_ready` / `# END wait_for_api_ready` markers and run
 * in a real bash subprocess, so this test tracks the actual deployed
 * behavior instead of a hand-written mirror that could silently drift.
 *
 * The subprocess MUST be spawned asynchronously (`Bun.spawn`, not
 * `Bun.spawnSync`): the mock `Bun.serve` server used below runs its `fetch`
 * handler on this same process's event loop, and `Bun.spawnSync` blocks that
 * event loop for its entire duration — the mock server would never be able
 * to answer a request from the very curl subprocess we're waiting on.
 */

const entrypointPath = `${import.meta.dir}/../../docker-entrypoint.sh`;

function extractWaitForApiReady(): string {
  const script = readFileSync(entrypointPath, "utf8");

  const beginMarker = "# BEGIN wait_for_api_ready";
  const beginIndex = script.indexOf(beginMarker);
  if (beginIndex === -1) {
    throw new Error(
      "Could not locate `# BEGIN wait_for_api_ready` marker in docker-entrypoint.sh — did the API readiness gate move?",
    );
  }

  const funcStart = script.indexOf("wait_for_api_ready() {", beginIndex);
  if (funcStart === -1) {
    throw new Error("Could not locate `wait_for_api_ready() {` definition after the BEGIN marker.");
  }

  const endMarker = "# END wait_for_api_ready";
  const endIndex = script.indexOf(endMarker, funcStart);
  if (endIndex === -1) {
    throw new Error("Could not locate `# END wait_for_api_ready` marker in docker-entrypoint.sh.");
  }

  return script.slice(funcStart, endIndex);
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Run the real extracted helper against `url` in a fresh bash subprocess. */
async function runWaitForApiReady(
  url: string,
  env: Record<string, string> = {},
): Promise<RunResult> {
  const funcSrc = extractWaitForApiReady();
  const script = `set -u\n${funcSrc}\nwait_for_api_ready "$1"\n`;

  const start = performance.now();
  const proc = Bun.spawn(["bash", "-c", script, "bash", url], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const durationMs = performance.now() - start;

  return { exitCode, stdout, stderr, durationMs };
}

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("wait_for_api_ready: source contract", () => {
  test("the gate call precedes the first provider-specific API read", () => {
    const script = readFileSync(entrypointPath, "utf8");
    const gateCallIndex = script.indexOf('wait_for_api_ready "$MCP_URL"');
    expect(gateCallIndex).toBeGreaterThan(-1);

    // The codex_oauth boot-seed restore is the earliest provider-specific
    // control-plane read in the file (inside the HARNESS_PROVIDER chain).
    const firstProviderReadIndex = script.indexOf(
      "api/config/resolved?includeSecrets=true",
      gateCallIndex,
    );
    expect(firstProviderReadIndex).toBeGreaterThan(gateCallIndex);
  });

  test("uses bounded per-attempt curl flags, not an unbounded request", () => {
    const funcSrc = extractWaitForApiReady();
    expect(funcSrc).toContain("--connect-timeout");
    expect(funcSrc).toContain("--max-time");
  });

  test("never references API_KEY or an Authorization header", () => {
    const funcSrc = extractWaitForApiReady();
    expect(funcSrc).not.toContain("API_KEY");
    expect(funcSrc).not.toContain("Authorization");
  });
});

describe("wait_for_api_ready: invalid timeout values", () => {
  test.each(["0", "-5", "abc"])("rejects %s with a stable fatal message", async (raw) => {
    const result = await runWaitForApiReady("http://127.0.0.1:1/health", {
      WORKER_API_READY_TIMEOUT_SECONDS: raw,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(
      `WORKER_API_READY_TIMEOUT_SECONDS must be a positive integer, got '${raw}'; exiting.`,
    );
    // Fails fast on the config check — must not attempt any network call.
    expect(result.durationMs).toBeLessThan(1000);
  });

  test("an explicitly-empty value falls back to the 90s default (bash :- semantics)", async () => {
    // `${VAR:-90}` treats "set but empty" the same as "unset" — the empty
    // branch in the case statement is defensive, not reachable via env.
    // Don't wait for the full 90s poll to finish: read the first log line,
    // then kill the still-polling process.
    const funcSrc = extractWaitForApiReady();
    const script = `set -u\n${funcSrc}\nwait_for_api_ready "$1"\n`;
    const proc = Bun.spawn(["bash", "-c", script, "bash", "http://127.0.0.1:1/health"], {
      env: {
        PATH: process.env.PATH ?? "",
        WORKER_API_READY_TIMEOUT_SECONDS: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const firstLine = new TextDecoder().decode(value);
    reader.releaseLock();
    proc.kill();
    await proc.exited;

    expect(firstLine).toContain("(timeout 90s)");
    expect(firstLine).not.toContain("must be a positive integer");
  }, 10000);
});

describe("wait_for_api_ready: immediate success", () => {
  test("succeeds on the first attempt and logs waiting + ready lines", async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health") return new Response("ok", { status: 200 });
        return new Response("not found", { status: 404 });
      },
    });

    const result = await runWaitForApiReady(server.url.toString(), {
      WORKER_API_READY_TIMEOUT_SECONDS: "5",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Waiting for API readiness at");
    expect(result.stdout).toContain("API ready at");
    expect(result.durationMs).toBeLessThan(5000);
  }, 15000);

  test("normalizes a trailing slash so it requests exactly /health", async () => {
    let requestedPath = "";
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        requestedPath = new URL(req.url).pathname;
        return new Response("ok", { status: 200 });
      },
    });

    const trailingSlashUrl = server.url.toString(); // Bun.serve URLs already end in "/"
    expect(trailingSlashUrl.endsWith("/")).toBe(true);

    const result = await runWaitForApiReady(trailingSlashUrl, {
      WORKER_API_READY_TIMEOUT_SECONDS: "5",
    });

    expect(result.exitCode).toBe(0);
    expect(requestedPath).toBe("/health");
  }, 15000);

  test("never leaks a secret placed in the process environment", async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health") return new Response("ok", { status: 200 });
        return new Response("not found", { status: 404 });
      },
    });

    const secret = "sk-super-secret-token-do-not-leak";
    const result = await runWaitForApiReady(server.url.toString(), {
      WORKER_API_READY_TIMEOUT_SECONDS: "5",
      API_KEY: secret,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  }, 15000);
});

describe("wait_for_api_ready: transient failure then success", () => {
  test("retries roughly once per second until the server recovers", async () => {
    let requestCount = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/health") return new Response("not found", { status: 404 });
        requestCount += 1;
        if (requestCount < 3) return new Response("unavailable", { status: 503 });
        return new Response("ok", { status: 200 });
      },
    });

    const result = await runWaitForApiReady(server.url.toString(), {
      WORKER_API_READY_TIMEOUT_SECONDS: "10",
    });

    expect(result.exitCode).toBe(0);
    expect(requestCount).toBeGreaterThanOrEqual(3);
    expect(result.stdout).toContain("API ready at");
    // Two ~1s retries before success — bounded, not instant, not stalled.
    expect(result.durationMs).toBeGreaterThanOrEqual(1500);
    expect(result.durationMs).toBeLessThan(15000);
  }, 20000);
});

describe("wait_for_api_ready: unreachable / timeout", () => {
  test("exits non-zero with a stable fatal line after the bounded window", async () => {
    // Port 1 is a well-known privileged port nothing is listening on inside
    // this sandbox; the connection is refused immediately and deterministically.
    const url = "http://127.0.0.1:1";
    const result = await runWaitForApiReady(url, { WORKER_API_READY_TIMEOUT_SECONDS: "2" });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(
      `FATAL: API readiness timed out after 2s waiting for ${url}/health; exiting.`,
    );
    // Bounded: at least one retry happened (not instant) and it never runs
    // substantially longer than the configured timeout. The lower bound is
    // deliberately loose: the deadline is computed from `date +%s`, which has
    // 1-second granularity, so a 2s timeout can legitimately resolve in ~1-3
    // real seconds depending on where "now" lands within the current second.
    // That slop is proportionally invisible at the real 90s production default.
    expect(result.durationMs).toBeGreaterThanOrEqual(900);
    expect(result.durationMs).toBeLessThan(15000);
  }, 20000);

  test("bounds total wall-clock time even against a server that never responds", async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        // Never resolves — simulates a hung/unresponsive API. curl's
        // --max-time must cut this off rather than hanging indefinitely.
        return new Promise<Response>(() => {});
      },
    });

    const result = await runWaitForApiReady(server.url.toString(), {
      WORKER_API_READY_TIMEOUT_SECONDS: "2",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("FATAL: API readiness timed out after 2s waiting for");
    // Per-attempt --max-time 3 plus the 2s deadline check bounds this well
    // under a runaway hang, but above the raw 2s deadline.
    expect(result.durationMs).toBeLessThan(15000);
  }, 20000);
});
