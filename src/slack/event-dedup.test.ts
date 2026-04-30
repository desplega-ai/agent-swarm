import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _createTestCache, _resetForTests, wasEventSeen } from "./event-dedup";

describe("wasEventSeen (production cache)", () => {
  beforeEach(() => {
    _resetForTests();
  });
  afterEach(() => {
    _resetForTests();
  });

  test("first call returns false (not seen)", () => {
    expect(wasEventSeen("Ev0001")).toBe(false);
  });

  test("second call with same id returns true (seen)", () => {
    expect(wasEventSeen("Ev0002")).toBe(false);
    expect(wasEventSeen("Ev0002")).toBe(true);
  });

  test("different ids do not collide", () => {
    expect(wasEventSeen("Ev0003")).toBe(false);
    expect(wasEventSeen("Ev0004")).toBe(false);
    expect(wasEventSeen("Ev0003")).toBe(true);
    expect(wasEventSeen("Ev0004")).toBe(true);
  });

  test("undefined / null / empty returns false (no-op)", () => {
    expect(wasEventSeen(undefined)).toBe(false);
    expect(wasEventSeen(null)).toBe(false);
    expect(wasEventSeen("")).toBe(false);
    // Calling again still returns false — empty/null is never inserted.
    expect(wasEventSeen(undefined)).toBe(false);
    expect(wasEventSeen(null)).toBe(false);
    expect(wasEventSeen("")).toBe(false);
  });

  test("repeated retry deliveries within TTL all return true after first", () => {
    expect(wasEventSeen("Ev_retry")).toBe(false);
    // Slack typically retries 3 times within ~60s
    expect(wasEventSeen("Ev_retry")).toBe(true);
    expect(wasEventSeen("Ev_retry")).toBe(true);
    expect(wasEventSeen("Ev_retry")).toBe(true);
  });
});

describe("isolated test cache (TTL behavior)", () => {
  test("entry expires after TTL elapses", () => {
    const cache = _createTestCache(1000); // 1s TTL
    try {
      expect(cache.wasEventSeen("Ev_ttl")).toBe(false);
      expect(cache.wasEventSeen("Ev_ttl")).toBe(true);

      cache.advance(500);
      expect(cache.wasEventSeen("Ev_ttl")).toBe(true); // still within TTL

      cache.advance(600); // total 1100ms — past TTL
      expect(cache.wasEventSeen("Ev_ttl")).toBe(false); // expired, treated as fresh
      expect(cache.wasEventSeen("Ev_ttl")).toBe(true); // re-inserted
    } finally {
      cache.destroy();
    }
  });

  test("size() reflects active entries after cleanup", () => {
    const cache = _createTestCache(1000);
    try {
      cache.wasEventSeen("a");
      cache.wasEventSeen("b");
      cache.wasEventSeen("c");
      expect(cache.size()).toBe(3);

      cache.advance(2000); // expire all
      expect(cache.size()).toBe(0);
    } finally {
      cache.destroy();
    }
  });

  test("zero-length keys still no-op in isolated cache", () => {
    const cache = _createTestCache(1000);
    try {
      expect(cache.wasEventSeen("")).toBe(false);
      expect(cache.wasEventSeen(null)).toBe(false);
      expect(cache.wasEventSeen(undefined)).toBe(false);
      expect(cache.size()).toBe(0);
    } finally {
      cache.destroy();
    }
  });

  test("custom TTL is honored independently per cache", () => {
    const short = _createTestCache(100);
    const long = _createTestCache(10_000);
    try {
      short.wasEventSeen("x");
      long.wasEventSeen("x");

      short.advance(200);
      long.advance(200);
      expect(short.wasEventSeen("x")).toBe(false); // expired
      expect(long.wasEventSeen("x")).toBe(true); // still alive
    } finally {
      short.destroy();
      long.destroy();
    }
  });

  test("simulated double-delivery races: second event returns hit even from concurrent code paths", () => {
    // Simulates: handler A and handler B both fire on the same event_id.
    // The first wins, the second drops.
    const cache = _createTestCache(60_000);
    try {
      const eventId = "EvABCDEF";
      const aSawIt = cache.wasEventSeen(eventId);
      const bSawIt = cache.wasEventSeen(eventId);
      expect(aSawIt).toBe(false);
      expect(bSawIt).toBe(true);
    } finally {
      cache.destroy();
    }
  });
});
