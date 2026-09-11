import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../utils/file-lock";

describe("withFileLock", () => {
  let root: string;
  let lock: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "file-lock-"));
    lock = join(root, "nested/dir/test.lock"); // parent created on demand
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("serializes concurrent holders", async () => {
    const events: string[] = [];
    const hold = (name: string) =>
      withFileLock(lock, async () => {
        events.push(`${name}:in`);
        await Bun.sleep(50);
        events.push(`${name}:out`);
      });

    await Promise.all([hold("a"), hold("b")]);

    expect(events).toHaveLength(4);
    expect(events[1]).toBe(events[0]?.replace(":in", ":out")); // no overlap
    expect(await Bun.file(lock).exists()).toBe(false); // released
  });

  test("gives up after waitMs while a live holder has it", async () => {
    await Bun.write(lock, "someone-else");
    const result = await withFileLock(lock, async () => "ran", { waitMs: 100 });

    expect(result).toEqual({ acquired: false });
    expect(await Bun.file(lock).text()).toBe("someone-else");
  });

  test("breaks a lock abandoned by a dead holder", async () => {
    await Bun.write(lock, "dead-holder");
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);

    expect(await withFileLock(lock, async () => "ran", { waitMs: 100 })).toEqual({
      acquired: true,
      value: "ran",
    });
  });

  test("does not delete a lock it no longer owns", async () => {
    await withFileLock(lock, async () => {
      await Bun.write(lock, "taken-over"); // ours was broken as stale meanwhile
    });

    expect(await Bun.file(lock).text()).toBe("taken-over");
  });

  test("releases the lock when fn throws", async () => {
    await expect(
      withFileLock(lock, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await Bun.file(lock).exists()).toBe(false);
  });
});
