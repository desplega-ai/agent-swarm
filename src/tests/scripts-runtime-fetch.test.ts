// DES-770: runtimeFetch must honor already-aborted / mid-flight caller aborts
// instead of running (and retrying) attempts for a cancelled request. All tests
// count real attempts against a Bun.serve fixture — no mock.module (leaks
// process-wide across the test run).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runtimeFetch } from "../scripts-runtime/stdlib/fetch";

describe("runtimeFetch abort handling", () => {
  let fixture: ReturnType<typeof Bun.serve>;
  let origin = "";
  const hits: Record<string, number> = {};
  // Stalled handlers park their resolvers here; afterAll releases them so the
  // fixture can shut down cleanly.
  const stallReleases: Array<() => void> = [];
  let onStallHit: (() => void) | undefined;

  beforeAll(() => {
    fixture = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        hits[path] = (hits[path] ?? 0) + 1;
        if (path.startsWith("/stall")) {
          onStallHit?.();
          await new Promise<void>((resolve) => stallReleases.push(resolve));
        }
        if (path === "/flaky" && hits[path] === 1) {
          return new Response("boom", { status: 500 });
        }
        return new Response("ok");
      },
    });
    origin = `http://127.0.0.1:${fixture.port}`;
  });

  afterAll(() => {
    for (const release of stallReleases) release();
    fixture.stop(true);
  });

  async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => {
        throw new Error("expected runtimeFetch to reject");
      },
      (error: unknown) => error,
    );
  }

  test("already-aborted signal rejects immediately with zero fetch attempts", async () => {
    const error = await rejectionOf(
      runtimeFetch(`${origin}/pre-aborted`, {
        signal: AbortSignal.abort(),
        retries: 3,
        timeoutMs: 30_000,
      }),
    );
    expect((error as DOMException).name).toBe("AbortError");
    expect(hits["/pre-aborted"]).toBeUndefined();
  });

  test("already-aborted signal propagates the caller's abort reason", async () => {
    const reason = new Error("caller cancelled");
    const error = await rejectionOf(
      runtimeFetch(`${origin}/pre-aborted-reason`, {
        signal: AbortSignal.abort(reason),
        retries: 3,
        timeoutMs: 30_000,
      }),
    );
    expect(error).toBe(reason);
    expect(hits["/pre-aborted-reason"]).toBeUndefined();
  });

  test("mid-flight abort rejects after exactly one attempt, no retry", async () => {
    const arrived = new Promise<void>((resolve) => {
      onStallHit = resolve;
    });
    const controller = new AbortController();
    const pending = runtimeFetch(`${origin}/stall-abort`, {
      signal: controller.signal,
      retries: 3,
      timeoutMs: 5_000,
    });
    await arrived;
    onStallHit = undefined;
    controller.abort();
    const error = await rejectionOf(pending);
    expect((error as DOMException).name).toBe("AbortError");
    // Give a would-be retry time to land before asserting the attempt count.
    await Bun.sleep(50);
    expect(hits["/stall-abort"]).toBe(1);
  });

  test("timeout abort still retries up to the retry budget", async () => {
    // Live, never-aborted caller signal: proves signal presence doesn't turn
    // the controller's own timeout abort into a terminal error.
    const controller = new AbortController();
    const error = await rejectionOf(
      runtimeFetch(`${origin}/stall-timeout`, {
        signal: controller.signal,
        retries: 2,
        timeoutMs: 100,
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(hits["/stall-timeout"]).toBe(2);
  });

  test("5xx responses still retry and succeed on a later attempt", async () => {
    const controller = new AbortController();
    const res = await runtimeFetch(`${origin}/flaky`, {
      signal: controller.signal,
      retries: 3,
      timeoutMs: 5_000,
    });
    expect(res.status).toBe(200);
    expect(hits["/flaky"]).toBe(2);
  });
});
