import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../utils/file-lock";

const HOLDER = join(import.meta.dir, "fixtures/file-lock-holder.ts");

/** Start a separate process holding the lock; resolves once it has it. */
async function holdInAnotherProcess(lockPath: string, holdMs: number) {
  const child = Bun.spawn([process.execPath, HOLDER, lockPath, String(holdMs)], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  let out = "";
  while (!out.includes("locked")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`holder exited before locking: ${out}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return child;
}

describe("withFileLock (kernel flock)", () => {
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
  });

  test("a live holder in another process is never robbed, however long it holds", async () => {
    // No staleness threshold exists: a slow or suspended holder keeps the lock.
    const holder = await holdInAnotherProcess(lock, 1_500);
    try {
      const whileHeld = await withFileLock(lock, async () => "ran", { waitMs: 300 });
      expect(whileHeld).toEqual({ acquired: false, reason: "busy" });

      await holder.exited;
      expect(await withFileLock(lock, async () => "ran", { waitMs: 1_000 })).toEqual({
        acquired: true,
        value: "ran",
      });
    } finally {
      holder.kill();
    }
  });

  test("a holder killed with SIGKILL releases the lock", async () => {
    const holder = await holdInAnotherProcess(lock, 60_000);
    holder.kill("SIGKILL");
    await holder.exited;

    expect(await withFileLock(lock, async () => "ran", { waitMs: 1_000 })).toEqual({
      acquired: true,
      value: "ran",
    });
  });

  test("releases the lock when fn throws, and never deletes the lock file", async () => {
    await expect(
      withFileLock(lock, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await Bun.file(lock).exists()).toBe(true); // unlinking would allow a second inode
    expect(await withFileLock(lock, async () => "again", { waitMs: 100 })).toEqual({
      acquired: true,
      value: "again",
    });
  });
});
