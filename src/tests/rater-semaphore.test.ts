/**
 * Tests for the host-wide rater semaphore + API back-pressure probe.
 *
 * Background: production OOM cascade caused by unbounded rater fan-out.
 * The semaphore ships in the worker hook to cap concurrent `claude -p`
 * haiku subprocesses across sibling Stop
 * hooks on the same host — see `src/utils/rater-semaphore.ts` for the
 * full rationale.
 *
 * Each test uses an isolated tmp lock directory so concurrent test files
 * don't fight over the production `/tmp/agent-swarm-rater-locks` dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRaterSlot,
  DEFAULT_MAX_CONCURRENT_RATERS,
  isApiHealthy,
} from "../utils/rater-semaphore";

let lockDir = "";

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), "rater-sem-test-"));
});

afterEach(() => {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("acquireRaterSlot", () => {
  test("hands out up to `max` slots concurrently, then refuses", () => {
    const max = 2;
    const a = acquireRaterSlot({ max, dir: lockDir });
    const b = acquireRaterSlot({ max, dir: lockDir });
    const c = acquireRaterSlot({ max, dir: lockDir });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).toBeNull();

    // Released slots become reclaimable.
    a?.release();
    const d = acquireRaterSlot({ max, dir: lockDir });
    expect(d).not.toBeNull();

    b?.release();
    d?.release();
  });

  test("uses DEFAULT_MAX_CONCURRENT_RATERS when no max is provided", () => {
    // Hand out the default cap, then verify the next acquire fails.
    const holders = [];
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT_RATERS; i++) {
      const h = acquireRaterSlot({ dir: lockDir });
      expect(h).not.toBeNull();
      holders.push(h);
    }
    const overflow = acquireRaterSlot({ dir: lockDir });
    expect(overflow).toBeNull();
    for (const h of holders) h?.release();
  });

  test("GCs stale locks so a SIGKILL-orphaned slot doesn't reduce capacity forever", () => {
    const max = 1;
    const stuck = acquireRaterSlot({ max, dir: lockDir });
    expect(stuck).not.toBeNull();

    // Backdate the file's mtime past the stale threshold and verify a
    // fresh acquire reclaims it.
    const lockPath = stuck!.path;
    const past = new Date(Date.now() - 5 * 60_000); // 5 min ago
    utimesSync(lockPath, past, past);

    const reclaimed = acquireRaterSlot({ max, staleMs: 60_000, dir: lockDir });
    expect(reclaimed).not.toBeNull();

    // Sanity: only the new lock survives in the dir.
    const remaining = readdirSync(lockDir).filter((e) => e.startsWith("lock-"));
    expect(remaining).toHaveLength(1);

    reclaimed?.release();
    // Original handle's release is idempotent — the file was already GC'd.
    stuck?.release();
  });

  test("release is idempotent — double release does not throw", () => {
    const slot = acquireRaterSlot({ max: 1, dir: lockDir });
    expect(slot).not.toBeNull();
    expect(() => {
      slot?.release();
      slot?.release();
    }).not.toThrow();
  });

  test("respects MEMORY_RATER_MAX_CONCURRENT env override", () => {
    const orig = process.env.MEMORY_RATER_MAX_CONCURRENT;
    process.env.MEMORY_RATER_MAX_CONCURRENT = "1";
    try {
      const a = acquireRaterSlot({ dir: lockDir });
      const b = acquireRaterSlot({ dir: lockDir });
      expect(a).not.toBeNull();
      expect(b).toBeNull();
      a?.release();
    } finally {
      if (orig === undefined) delete process.env.MEMORY_RATER_MAX_CONCURRENT;
      else process.env.MEMORY_RATER_MAX_CONCURRENT = orig;
    }
  });
});

describe("isApiHealthy", () => {
  test("returns true on 2xx /health", async () => {
    const fakeFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const healthy = await isApiHealthy({
      apiUrl: "http://api",
      fetchImpl: fakeFetch,
    });
    expect(healthy).toBe(true);
  });

  test("returns false on non-2xx /health", async () => {
    const fakeFetch = (async () => new Response("err", { status: 503 })) as unknown as typeof fetch;
    const healthy = await isApiHealthy({
      apiUrl: "http://api",
      fetchImpl: fakeFetch,
    });
    expect(healthy).toBe(false);
  });

  test("returns false on fetch throw (network down)", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const healthy = await isApiHealthy({
      apiUrl: "http://api",
      fetchImpl: fakeFetch,
    });
    expect(healthy).toBe(false);
  });

  test("returns false on timeout", async () => {
    // Slow fetch that never resolves before the abort fires.
    const fakeFetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }
        // Never resolves on its own.
        setTimeout(() => resolve(new Response("late")), 5_000).unref?.();
      })) as unknown as typeof fetch;

    const start = Date.now();
    const healthy = await isApiHealthy({
      apiUrl: "http://api",
      timeoutMs: 100,
      fetchImpl: fakeFetch,
    });
    const elapsed = Date.now() - start;

    expect(healthy).toBe(false);
    // Cheap sanity check that we actually timed out fast rather than
    // hung the test runner. Bun's setTimeout precision is plenty.
    expect(elapsed).toBeLessThan(1_000);
  });

  test("sends Authorization: Bearer <key> when apiKey is provided", async () => {
    let captured: Record<string, string> | undefined;
    const fakeFetch = ((_url: string, init?: RequestInit) => {
      captured = init?.headers as Record<string, string> | undefined;
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as unknown as typeof fetch;

    await isApiHealthy({
      apiUrl: "http://api",
      apiKey: "secret",
      fetchImpl: fakeFetch,
    });

    expect(captured?.Authorization).toBe("Bearer secret");
  });
});
