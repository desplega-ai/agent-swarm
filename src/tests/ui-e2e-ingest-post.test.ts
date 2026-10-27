import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { IngestPayload } from "../../packages/ui-e2e/reporter/ingest-payload.ts";
import {
  isTransportFailure,
  postPayloads,
  RETRY_DELAYS_MS,
} from "../../packages/ui-e2e/reporter/ingest-post.ts";

// A fake ingest endpoint: each request pops the next scripted response.
type Reply = { status: number; body: unknown } | "html-502";
let replies: Reply[] = [];
let received: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let url: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push(await req.text());
      const reply = replies.shift() ?? {
        status: 200,
        body: { ok: true, result: {}, durationMs: 1 },
      };
      if (reply === "html-502") {
        return new Response("<html>502 Bad Gateway</html>", { status: 502 });
      }
      return Response.json(reply.body, { status: reply.status });
    },
  });
  url = `http://127.0.0.1:${server.port}/api/x/script/endpoint`;
});

afterAll(() => server.stop(true));

beforeEach(() => {
  replies = [];
  received = [];
});

function payload(statuses: Array<"passed" | "failed"> = ["passed"]): IngestPayload {
  return {
    schemaVersion: 1,
    run: {
      repo: "desplega-ai/agent-swarm",
      ref: "main",
      sha: "0123456789abcdef0123456789abcdef01234567",
      prNumber: null,
      trigger: "main",
      runner: "ci",
      isFork: false,
      shardIndex: 1,
      shardTotal: 2,
      startedAt: "2026-10-27T15:00:00.000Z",
      finishedAt: "2026-10-27T15:01:00.000Z",
    },
    results: statuses.map((status, index) => ({
      specId: `spec-${index}`,
      title: `spec ${index}`,
      status,
      durationMs: 10,
      retries: 0,
    })),
    artifacts: [],
  } as IngestPayload;
}

const ok = { status: 200, body: { ok: true, result: { runKey: "k" }, durationMs: 5 } };
const reset = {
  status: 200,
  body: {
    ok: false,
    result: null,
    error: {
      type: "runtime_error",
      message:
        "TypeError: ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
    },
    durationMs: 74866,
  },
};

function recordSleeps() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

test("the default backoff outlasts a five-minute deploy", () => {
  expect(RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThan(5 * 60_000);
});

test("retries an HTTP 502 and resends the identical body", async () => {
  replies = ["html-502", ok];
  const { delays, sleep } = recordSleeps();
  expect(await postPayloads([payload()], url, "secret", { sleep })).toBe(true);
  expect(received).toHaveLength(2);
  expect(received[1]).toBe(received[0]);
  expect(delays).toEqual([RETRY_DELAYS_MS[0]]);
});

test("retries a 200 ok=false caused by a transport error", async () => {
  replies = [reset, reset, ok];
  const { delays, sleep } = recordSleeps();
  expect(await postPayloads([payload()], url, "secret", { sleep })).toBe(true);
  expect(received).toHaveLength(3);
  expect(delays).toEqual(RETRY_DELAYS_MS.slice(0, 2));
});

test("retries a network error", async () => {
  let calls = 0;
  const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return fetch(input, init);
  }) as typeof fetch;
  const { sleep } = recordSleeps();
  expect(await postPayloads([payload()], url, "secret", { fetch: flaky, sleep })).toBe(true);
  expect(calls).toBe(2);
  expect(received).toHaveLength(1);
});

test("fails once retries are exhausted", async () => {
  replies = Array.from({ length: 10 }, () => ({ status: 503, body: { error: "down" } }));
  const { delays, sleep } = recordSleeps();
  expect(await postPayloads([payload()], url, "secret", { sleep })).toBe(false);
  expect(received).toHaveLength(RETRY_DELAYS_MS.length + 1);
  expect(delays).toEqual(RETRY_DELAYS_MS);
});

test("does not retry a 4xx", async () => {
  replies = [{ status: 401, body: { error: { message: "Unauthorized" } } }];
  const { delays, sleep } = recordSleeps();
  expect(await postPayloads([payload()], url, "secret", { sleep })).toBe(false);
  expect(received).toHaveLength(1);
  expect(delays).toEqual([]);
});

test("does not retry a validation error", async () => {
  replies = [
    {
      status: 200,
      body: {
        ok: false,
        result: null,
        error: { type: "args_validation", message: "run.sha is required" },
        durationMs: 0,
      },
    },
  ];
  const { sleep } = recordSleeps();
  expect(await postPayloads([payload()], url, "secret", { sleep })).toBe(false);
  expect(received).toHaveLength(1);
});

test("does not resend a shard with failed specs", async () => {
  replies = ["html-502", ok];
  const { delays, sleep } = recordSleeps();
  expect(await postPayloads([payload(["passed", "failed"])], url, "secret", { sleep })).toBe(false);
  expect(received).toHaveLength(1);
  expect(delays).toEqual([]);
});

test("a failed shard does not stop the next shard from posting", async () => {
  replies = [{ status: 400, body: { error: { message: "bad" } } }, ok];
  const { sleep } = recordSleeps();
  expect(await postPayloads([payload(), payload()], url, "secret", { sleep })).toBe(false);
  expect(received).toHaveLength(2);
});

test("classifies transport failures in the script envelope", () => {
  expect(isTransportFailure(reset.body)).toBe(true);
  expect(isTransportFailure({ ok: false, error: { type: "capacity_exceeded", message: "" } })).toBe(
    true,
  );
  expect(
    isTransportFailure({ ok: false, error: { type: "runtime_error", message: "Error: bad sha" } }),
  ).toBe(false);
  expect(isTransportFailure({ ok: false, error: { type: "timeout", message: "x" } })).toBe(false);
});
