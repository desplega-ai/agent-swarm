import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIngressBuffer } from "../tasks/additive-ingress";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const FLAG = "TEST_ADDITIVE_INGRESS";

describe("createIngressBuffer", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
  });
  afterEach(() => {
    process.env[FLAG] = undefined;
  });

  test("env flag off → maybeBuffer always returns false", () => {
    process.env[FLAG] = "false";
    const flushes: string[][] = [];
    const ib = createIngressBuffer<string>({
      source: "test",
      envFlag: FLAG,
      timeoutMs: 20,
      onFlush: (items) => {
        flushes.push([...items]);
      },
    });
    expect(ib.enabled).toBe(false);
    expect(ib.maybeBuffer("ctx", true, "a")).toBe(false);
    expect(ib.isBuffered("ctx")).toBe(false);
  });

  test("no sibling in flight → maybeBuffer returns false", () => {
    const ib = createIngressBuffer<string>({
      source: "test",
      envFlag: FLAG,
      timeoutMs: 20,
      onFlush: () => {},
    });
    expect(ib.enabled).toBe(true);
    expect(ib.maybeBuffer("ctx", false, "a")).toBe(false);
  });

  test("empty contextKey → maybeBuffer returns false", () => {
    const ib = createIngressBuffer<string>({
      source: "test",
      envFlag: FLAG,
      timeoutMs: 20,
      onFlush: () => {},
    });
    expect(ib.maybeBuffer("", true, "a")).toBe(false);
  });

  test("enabled + sibling in flight + contextKey → buffers", async () => {
    const flushes: Array<{ items: string[]; key: string; reason: string }> = [];
    const ib = createIngressBuffer<string>({
      source: "test",
      envFlag: FLAG,
      timeoutMs: 20,
      onFlush: (items, key, reason) => {
        flushes.push({ items: [...items], key, reason });
      },
    });
    expect(ib.maybeBuffer("ctx", true, "one")).toBe(true);
    expect(ib.maybeBuffer("ctx", true, "two")).toBe(true);
    expect(ib.maybeBuffer("ctx", true, "three")).toBe(true);
    expect(ib.count("ctx")).toBe(3);

    await sleep(80);
    expect(flushes.length).toBe(1);
    expect(flushes[0]?.items).toEqual(["one", "two", "three"]);
    expect(flushes[0]?.key).toBe("ctx");
    expect(flushes[0]?.reason).toBe("timer");
  });

  test("instantFlush resolves immediately with reason=manual", async () => {
    const flushes: Array<{ items: string[]; reason: string }> = [];
    const ib = createIngressBuffer<string>({
      source: "test",
      envFlag: FLAG,
      timeoutMs: 5000, // long
      onFlush: (items, _key, reason) => {
        flushes.push({ items: [...items], reason });
      },
    });
    ib.maybeBuffer("k", true, "x");
    ib.maybeBuffer("k", true, "y");
    await ib.instantFlush("k");
    expect(flushes.length).toBe(1);
    expect(flushes[0]?.items).toEqual(["x", "y"]);
    expect(flushes[0]?.reason).toBe("manual");
  });

  test("cancel drops items without flushing", async () => {
    const flushes: string[][] = [];
    const ib = createIngressBuffer<string>({
      source: "test",
      envFlag: FLAG,
      timeoutMs: 20,
      onFlush: (items) => {
        flushes.push([...items]);
      },
    });
    ib.maybeBuffer("k", true, "a");
    ib.cancel("k");
    await sleep(50);
    expect(flushes.length).toBe(0);
    expect(ib.isBuffered("k")).toBe(false);
  });
});
