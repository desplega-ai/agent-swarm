import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_ROLLOUT_RETENTION_MS, pruneCodexRollouts } from "../providers/codex-rollouts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "codex-rollouts-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function rollout(day: string, name: string, ageMs: number): Promise<string> {
  const dir = join(home, ".codex", "sessions", day);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, "{}\n");
  const at = new Date(Date.now() - ageMs);
  await utimes(path, at, at);
  return path;
}

test("removes rollouts older than the retention window and keeps recent ones", async () => {
  const old = await rollout("2026/10/01", "rollout-2026-10-01T00-00-00-old.jsonl", 8 * 86_400_000);
  const fresh = await rollout("2026/10/27", "rollout-2026-10-27T00-00-00-new.jsonl", 3_600_000);

  const removed = await pruneCodexRollouts({ HOME: home });

  expect(removed).toBe(1);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  // Emptied day directories are cleaned up, populated ones are not.
  expect(existsSync(join(home, ".codex", "sessions", "2026", "10", "01"))).toBe(false);
  expect(existsSync(join(home, ".codex", "sessions", "2026", "10", "27"))).toBe(true);
});

test("ignores non-rollout files and honours CODEX_HOME", async () => {
  const other = join(home, "custom", "sessions", "2026", "01", "01");
  await mkdir(other, { recursive: true });
  const keep = join(other, "notes.jsonl");
  const drop = join(other, "rollout-x.jsonl");
  const longAgo = new Date(Date.now() - 2 * CODEX_ROLLOUT_RETENTION_MS);
  for (const p of [keep, drop]) {
    await writeFile(p, "{}\n");
    await utimes(p, longAgo, longAgo);
  }

  const removed = await pruneCodexRollouts({ CODEX_HOME: join(home, "custom") });

  expect(removed).toBe(1);
  expect(existsSync(keep)).toBe(true);
  expect(existsSync(drop)).toBe(false);
});

test("never throws when the sessions directory is missing", async () => {
  expect(await pruneCodexRollouts({ HOME: home })).toBe(0);
  expect(await pruneCodexRollouts({})).toBe(0);
});
