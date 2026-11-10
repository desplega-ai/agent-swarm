import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

// Regression for the merge-gate Secret Scan flake: GitHub's release host
// answered 504 (or dropped the connection) for longer than `curl --retry 3`
// rides out, so scripts/gitleaks.sh exited 2 before scanning anything.
// A raw TCP server plays a scripted sequence of failures, then serves bytes.
// The bytes are not the real tarball, so a download that got through ends at
// the SHA-256 check ("SHA-256 mismatch") instead of "download failed".

type Step = "504" | "drop" | "ok";

const SCRIPT = join(import.meta.dir, "../../scripts/gitleaks.sh");
const BODY = "not-the-gitleaks-tarball";
const RESPONSES = {
  // Retry-After: 1 keeps curl's backoff at one second per try.
  "504":
    "HTTP/1.1 504 Gateway Timeout\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
  ok: `HTTP/1.1 200 OK\r\nContent-Length: ${BODY.length}\r\nConnection: close\r\n\r\n${BODY}`,
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function downloadThrough(steps: Step[]) {
  let connections = 0;
  const server = Bun.listen<Step>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        const step = steps[Math.min(connections++, steps.length - 1)];
        if (step === "drop") socket.end();
        else socket.data = step;
      },
      data(socket) {
        socket.end(RESPONSES[socket.data as "504" | "ok"]);
      },
    },
  });
  cleanups.push(() => server.stop(true));
  const home = await mkdtemp(join(tmpdir(), "gitleaks-retry-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));

  const result = await runChild(["bash", SCRIPT, "HEAD..HEAD"], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CACHE_HOME: join(home, "cache"),
      GITLEAKS_DOWNLOAD_BASE_URL: `http://127.0.0.1:${server.port}`,
    },
  });
  return { ...result, connections };
}

describe("scripts/gitleaks.sh download retries", () => {
  test(
    "rides out a 504 burst longer than three retries",
    async () => {
      const r = await downloadThrough(["504", "504", "504", "504", "ok"]);
      expect(r.stderr).not.toContain("download failed");
      expect(r.stderr).toContain("SHA-256 mismatch");
      expect(r.exitCode).toBe(2);
      expect(r.connections).toBe(5);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "retries a dropped connection",
    async () => {
      const r = await downloadThrough(["drop", "drop", "ok"]);
      expect(r.stderr).not.toContain("download failed");
      expect(r.stderr).toContain("SHA-256 mismatch");
      expect(r.exitCode).toBe(2);
      expect(r.connections).toBe(3);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
