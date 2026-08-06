import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileFileFromDb } from "../commands/profile-sync";

let tempDir = "";

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("writeProfileFileFromDb", () => {
  test("archives differing local content before writing the DB value", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "profile-pre-boot-"));
    const filePath = join(tempDir, "HEARTBEAT.md");
    await Bun.write(filePath, "local unsynced content");

    const timestamp = new Date("2026-08-06T00:15:00.000Z");
    const backupPath = await writeProfileFileFromDb(filePath, "stale DB content", () => timestamp);

    expect(backupPath).toBe(`${filePath}.pre-boot-${timestamp.toISOString()}.bak`);
    expect(await Bun.file(filePath).text()).toBe("stale DB content");
    expect(await Bun.file(backupPath!).text()).toBe("local unsynced content");
  });

  test("does not create a backup when local and DB content match", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "profile-pre-boot-"));
    const filePath = join(tempDir, "TOOLS.md");
    await Bun.write(filePath, "same content");

    const backupPath = await writeProfileFileFromDb(filePath, "same content");

    expect(backupPath).toBeNull();
    expect(await readdir(tempDir)).toEqual(["TOOLS.md"]);
  });

  test("does not overwrite the local file when the backup cannot be created", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "profile-pre-boot-"));
    const filePath = join(tempDir, "CLAUDE.md");
    await Bun.write(filePath, "local unsynced content");

    const timestamp = new Date("2026-08-06T00:16:00.000Z");
    await mkdir(`${filePath}.pre-boot-${timestamp.toISOString()}.bak`);

    await expect(
      writeProfileFileFromDb(filePath, "stale DB content", () => timestamp),
    ).rejects.toThrow();
    expect(await Bun.file(filePath).text()).toBe("local unsynced content");
  });
});
