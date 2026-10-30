import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForApiReady } from "../commands/entrypoint-api-readiness";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

/**
 * Regression tests for the `wait_for_api_ready` bounded /health poll in
 * docker-entrypoint.sh before provider configuration reads.
 *
 * Run the deployed shell shim with its Bun helper against a real HTTP server.
 * Image paths for Bun and the helper are relocated to the test runtime and an isolated copy; the shell
 * call, argument handling, exit status and TypeScript logic are the real ones.
 * Injected clocks and probes also cover policy without wall-clock waits.
 */

const TEST_TIMEOUT = CHILD_PROCESS_TEST_BUDGET_MS;
const entrypointPath = `${import.meta.dir}/../../docker-entrypoint.sh`;
let helperDir: string;
let helperPath: string;

beforeAll(async () => {
  helperDir = await mkdtemp(join(tmpdir(), "swarm-readiness-"));
  helperPath = join(helperDir, "entrypoint-api-readiness.ts");
  // Copy only the file shipped by each image: no repo imports or node_modules.
  await Bun.write(
    helperPath,
    Bun.file(`${import.meta.dir}/../commands/entrypoint-api-readiness.ts`),
  );
});

afterAll(async () => {
  await rm(helperDir, { recursive: true, force: true });
});

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

  return script
    .slice(funcStart, endIndex)
    .replace("/usr/local/bin/bun", '"$3"')
    .replace("/usr/local/lib/agent-swarm/entrypoint-api-readiness.ts", '"$2"');
}

/** Run the real extracted helper against `url` in a fresh bash subprocess. */
async function runWaitForApiReady(
  url: string,
  env: Record<string, string> = {},
): Promise<Awaited<ReturnType<typeof runChild>>> {
  const funcSrc = extractWaitForApiReady();
  const script = `set -eu\n${funcSrc}\nwait_for_api_ready "$1" "$2" "$3"\necho 'provider setup reached'\n`;
  return runChild(["bash", "-c", script, "bash", url, helperPath, process.execPath], {
    cwd: helperDir,
    env: { PATH: process.env.PATH ?? "", ...env },
  });
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

  test("never references API_KEY or an Authorization header", () => {
    const funcSrc = extractWaitForApiReady();
    expect(funcSrc).not.toContain("API_KEY");
    expect(funcSrc).not.toContain("Authorization");
  });
});

describe("wait_for_api_ready: invalid timeout values", () => {
  test.each(["0", "-5", "abc"])(
    "rejects %s with a stable fatal message",
    async (raw) => {
      const result = await runWaitForApiReady("http://unused.invalid", {
        WORKER_API_READY_TIMEOUT_SECONDS: raw,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain(
        `WORKER_API_READY_TIMEOUT_SECONDS must be a positive integer, got '${raw}'; exiting.`,
      );
      // Fails fast on the config check — must not attempt any network call.
      expect(result.durationMs).toBeLessThan(5000);
      expect(result.stdout).not.toContain("provider setup reached");
    },
    TEST_TIMEOUT,
  );

  test(
    "an explicitly-empty value falls back to the 90s default (bash :- semantics)",
    async () => {
      server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
      const result = await runWaitForApiReady(server.url.toString(), {
        WORKER_API_READY_TIMEOUT_SECONDS: "",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("(timeout 90s)");
      expect(result.stdout).not.toContain("must be a positive integer");
    },
    TEST_TIMEOUT,
  );
});

describe("wait_for_api_ready: immediate success", () => {
  test(
    "succeeds on the first attempt and logs waiting + ready lines",
    async () => {
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
      expect(result.stdout).toContain("provider setup reached");
      expect(result.durationMs).toBeLessThan(5000);
    },
    TEST_TIMEOUT,
  );

  test(
    "normalizes a trailing slash so it requests exactly /health",
    async () => {
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
    },
    TEST_TIMEOUT,
  );

  test(
    "never leaks a secret placed in the process environment",
    async () => {
      let authorization: string | null | undefined;
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          authorization = req.headers.get("authorization");
          const url = new URL(req.url);
          if (url.pathname === "/health") return new Response("ok", { status: 200 });
          return new Response("not found", { status: 404 });
        },
      });

      const secret = "example-api-ready-secret-do-not-leak";
      const result = await runWaitForApiReady(server.url.toString(), {
        WORKER_API_READY_TIMEOUT_SECONDS: "5",
        API_KEY: secret,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      expect(authorization).toBeNull();
    },
    TEST_TIMEOUT,
  );
});

describe("wait_for_api_ready: transient failure then success", () => {
  test(
    "retries roughly once per second until the server recovers",
    async () => {
      // A per-test path prefix: an ephemeral port can be reused from another test
      // process whose poller still hits /health, and those stray requests used
      // to count as retries (3 requests in 1033 ms on CI).
      const prefix = `/${crypto.randomUUID()}`;
      const requestTimes: number[] = [];
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname !== `${prefix}/health`)
            return new Response("not found", { status: 404 });
          requestTimes.push(performance.now());
          if (requestTimes.length < 3) return new Response("unavailable", { status: 503 });
          return new Response("ok", { status: 200 });
        },
      });

      const result = await runWaitForApiReady(`${server.url.origin}${prefix}/`, {
        WORKER_API_READY_TIMEOUT_SECONDS: "10",
      });

      expect(result.exitCode).toBe(0);
      expect(requestTimes).toHaveLength(3);
      expect(result.stdout).toContain("API ready at");
      // Each retry waits out `sleep 1` after the previous response, so the
      // server-side gap cannot shrink under load: paced, not a hot loop.
      expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(900);
      expect(requestTimes[2]! - requestTimes[1]!).toBeGreaterThanOrEqual(900);
      expect(result.durationMs).toBeLessThan(15000);
    },
    TEST_TIMEOUT,
  );
});

describe("wait_for_api_ready: unreachable / timeout", () => {
  test(
    "exits non-zero with a stable fatal line after the bounded window",
    async () => {
      server = Bun.serve({ port: 0, fetch: () => new Response("unused") });
      const url = `${server.url.origin}/${crypto.randomUUID()}`;
      await server.stop(true);
      server = undefined;
      const result = await runWaitForApiReady(url, { WORKER_API_READY_TIMEOUT_SECONDS: "2" });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain(
        `FATAL: API readiness timed out after 2s waiting for ${url}/health; exiting.`,
      );
      expect(result.stdout).not.toContain("provider setup reached");
      expect(result.durationMs).toBeGreaterThanOrEqual(900);
      expect(result.durationMs).toBeLessThan(15000);
    },
    TEST_TIMEOUT,
  );

  test(
    "bounds total wall-clock time even against a server that never responds",
    async () => {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch() {
          // No response headers: the request deadline must abort the fetch.
          return new Promise<Response>(() => {});
        },
      });

      const result = await runWaitForApiReady(server.url.toString(), {
        WORKER_API_READY_TIMEOUT_SECONDS: "2",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("FATAL: API readiness timed out after 2s waiting for");
      expect(result.durationMs).toBeLessThan(15000);
    },
    TEST_TIMEOUT,
  );
});

describe("API readiness step with injected dependencies", () => {
  test.each([
    "0",
    "-1",
    "abc",
    "1.5",
    "Infinity",
    "9007199254740992",
  ])("rejects %s before probing or sleeping", async (value) => {
    let probes = 0;
    let sleeps = 0;
    const logs: string[] = [];
    expect(
      await waitForApiReady("http://api", value, {
        fetch: async () => {
          probes++;
          return new Response("ok");
        },
        sleep: async () => {
          sleeps++;
        },
        log: (message) => logs.push(message),
      }),
    ).toBe(false);
    expect(probes).toBe(0);
    expect(sleeps).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("must be a positive integer");
  });

  test("paces HTTP and connection failures until the API recovers", async () => {
    let now = 0;
    let probes = 0;
    const sleeps: number[] = [];
    const logs: string[] = [];
    const ready = await waitForApiReady("http://api/prefix/", "5", {
      now: () => now,
      fetch: async (url, init) => {
        expect(url).toBe("http://api/prefix/health");
        expect(init.redirect).toBe("manual");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        if (++probes === 1) return new Response("booting", { status: 503 });
        if (probes === 2) throw new Error("connection reset");
        return new Response("ok");
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      log: (message) => logs.push(message),
    });
    expect(ready).toBe(true);
    expect(probes).toBe(3);
    expect(sleeps).toEqual([1000, 1000]);
    expect(logs.at(-1)).toContain("API ready at");
  });

  test("stops at the overall deadline without an unbounded retry loop", async () => {
    let now = 0;
    const logs: string[] = [];
    expect(
      await waitForApiReady("http://api", "2", {
        now: () => now,
        fetch: async () => new Response("unavailable", { status: 503 }),
        sleep: async (ms) => {
          now += ms;
        },
        log: (message) => logs.push(message),
      }),
    ).toBe(false);
    expect(now).toBe(2000);
    expect(logs.at(-1)).toBe(
      "[entrypoint] FATAL: API readiness timed out after 2s waiting for http://api/health; exiting.",
    );
  });

  test("a successful response arriving after the deadline does not continue boot", async () => {
    let now = 0;
    const logs: string[] = [];
    expect(
      await waitForApiReady("http://api", "1", {
        now: () => now,
        fetch: async () => {
          now = 1001;
          return new Response("ok");
        },
        log: (message) => logs.push(message),
      }),
    ).toBe(false);
    expect(logs.at(-1)).toContain("FATAL: API readiness timed out");
    expect(logs.some((message) => message.includes("API ready at"))).toBe(false);
  });
});

describe("API readiness HTTP compatibility", () => {
  test.each(["headers", "body"])(
    "retries a stalled %s request after the three-second request cap",
    async (phase) => {
      const prefix = `/${crypto.randomUUID()}`;
      const requestTimes: number[] = [];
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          if (new URL(req.url).pathname !== `${prefix}/health`)
            return new Response("not found", { status: 404 });
          requestTimes.push(performance.now());
          if (requestTimes.length > 1) return new Response("ok");
          if (phase === "headers") return new Promise<Response>(() => {});
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("partial"));
              },
            }),
          );
        },
      });

      const result = await runWaitForApiReady(`${server.url.origin}${prefix}`, {
        WORKER_API_READY_TIMEOUT_SECONDS: "8",
      });

      expect(result.exitCode).toBe(0);
      expect(requestTimes).toHaveLength(2);
      // Three seconds to abort, then the existing one-second retry spacing.
      expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(3500);
      expect(requestTimes[1]! - requestTimes[0]!).toBeLessThan(7000);
      expect(result.stdout).toContain("API ready at");
      expect(result.stdout).toContain("provider setup reached");
    },
    TEST_TIMEOUT,
  );

  test(
    "uses the image's Bun even when a worker-writable PATH shadows bun",
    async () => {
      const shadow = join(helperDir, "bun");
      await Bun.write(shadow, "#!/bin/sh\necho 'untrusted bun was executed'\nexit 99\n");
      await chmod(shadow, 0o755);
      server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
      const result = await runWaitForApiReady(server.url.origin, {
        WORKER_API_READY_TIMEOUT_SECONDS: "2",
        PATH: `${helperDir}:${process.env.PATH ?? ""}`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("untrusted bun was executed");
      expect(result.stdout).toContain("provider setup reached");
    },
    TEST_TIMEOUT,
  );

  test(
    "accepts a redirect without following it, like curl -f without -L",
    async () => {
      const paths: string[] = [];
      server = Bun.serve({
        port: 0,
        fetch(req) {
          paths.push(new URL(req.url).pathname);
          return Response.redirect(`${server!.url.origin}/should-not-be-requested`, 302);
        },
      });
      const result = await runWaitForApiReady(server.url.origin, {
        WORKER_API_READY_TIMEOUT_SECONDS: "2",
      });
      expect(result.exitCode).toBe(0);
      expect(paths).toEqual(["/health"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "bounds a response body that never finishes after successful headers",
    async () => {
      server = Bun.serve({
        port: 0,
        fetch: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("partial"));
              },
            }),
          ),
      });
      const result = await runWaitForApiReady(server.url.origin, {
        WORKER_API_READY_TIMEOUT_SECONDS: "1",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("FATAL: API readiness timed out after 1s");
      expect(result.stdout).not.toContain("provider setup reached");
      expect(result.durationMs).toBeLessThan(15000);
    },
    TEST_TIMEOUT,
  );
});
