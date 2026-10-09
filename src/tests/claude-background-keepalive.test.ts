import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { ClaudeBackgroundKeepalive } from "../providers/claude-background-keepalive";

// The keepalive's contract is the HTTP heartbeat it sends while Claude idles on
// background work. A local server records those requests; short intervals keep
// the timing real without fake clocks.
const INTERVAL_MS = 20;
// Real timers under CI's parallel load can slip a tick; retry instead of
// widening every window.
const TIMING = { retry: 2 };
const received: Array<{ method: string; path: string; auth: string | null; agent: string | null }> =
  [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    received.push({
      method: req.method,
      path: url.pathname,
      auth: req.headers.get("authorization"),
      agent: req.headers.get("x-agent-id"),
    });
    return Response.json({ updated: true });
  },
});

afterAll(() => server.stop(true));
beforeEach(() => {
  received.length = 0;
});

function keepalive(maxIdleMs?: number, apiUrl = `http://127.0.0.1:${server.port}`) {
  return new ClaudeBackgroundKeepalive({
    apiUrl,
    apiKey: "key-123",
    agentId: "agent-1",
    taskId: "task-1",
    intervalMs: INTERVAL_MS,
    maxIdleMs,
  });
}

const bgChanged = (tasks: Array<Record<string, unknown>>) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks,
});

describe("ClaudeBackgroundKeepalive", () => {
  test(
    "keeps heartbeating after the turn ends while a background Bash job is live",
    async () => {
      const k = keepalive();
      // Message order from the stalled run: the backgrounded Bash joins the set,
      // the assistant ends its turn, then the process goes silent.
      k.observe(
        bgChanged([{ task_id: "bscveebhn", task_type: "local_bash", description: "Wait for TLC" }]),
      );
      k.observe({ type: "assistant" });
      k.observe({ type: "result", subtype: "success" });
      await Bun.sleep(INTERVAL_MS * 6);
      k.stop();

      expect(received.length).toBeGreaterThanOrEqual(3);
      expect(received[0]).toEqual({
        method: "PUT",
        path: "/api/active-sessions/heartbeat/task-1",
        auth: "Bearer key-123",
        agent: "agent-1",
      });
    },
    TIMING,
  );

  test(
    "a silent session with no background work sends nothing, so it still goes stale",
    async () => {
      const k = keepalive();
      k.observe({ type: "assistant" });
      k.observe({ type: "result", subtype: "success" });
      // Ambient watchers are not activity either.
      k.observe(bgChanged([{ task_id: "watcher", ambient: true }]));
      await Bun.sleep(INTERVAL_MS * 5);
      k.stop();
      expect(received).toHaveLength(0);
    },
    TIMING,
  );

  test(
    "stops when the background set empties",
    async () => {
      const k = keepalive();
      k.observe(bgChanged([{ task_id: "a" }, { task_id: "b" }]));
      await Bun.sleep(INTERVAL_MS * 3);
      k.observe(bgChanged([]));
      await Bun.sleep(INTERVAL_MS);
      const settled = received.length;
      expect(settled).toBeGreaterThan(0);
      await Bun.sleep(INTERVAL_MS * 4);
      k.stop();
      expect(received).toHaveLength(settled);
    },
    TIMING,
  );

  test(
    "a background job that never settles is covered only up to the idle cap",
    async () => {
      const k = keepalive(INTERVAL_MS * 3);
      k.observe(bgChanged([{ task_id: "hung" }]));
      await Bun.sleep(INTERVAL_MS * 6);
      const capped = received.length;
      expect(capped).toBeGreaterThan(0);
      await Bun.sleep(INTERVAL_MS * 4);
      expect(received).toHaveLength(capped);

      // New output from the session restarts coverage while the job is live.
      k.observe({ type: "assistant" });
      await Bun.sleep(INTERVAL_MS * 2);
      k.stop();
      expect(received.length).toBeGreaterThan(capped);
    },
    TIMING,
  );

  test(
    "stop() ends the keepalive and ignores later messages",
    async () => {
      const k = keepalive();
      k.observe(bgChanged([{ task_id: "a" }]));
      k.stop();
      k.observe(bgChanged([{ task_id: "b" }]));
      await Bun.sleep(INTERVAL_MS * 4);
      expect(received).toHaveLength(0);
    },
    TIMING,
  );
});
