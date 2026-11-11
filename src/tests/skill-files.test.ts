import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createSkill,
  deleteSkill,
  deleteSkillFile,
  getDbClient,
  getSkillFile,
  initDb,
  listSkillFileManifest,
  normalizeSkillFilePath,
  upsertSkillFile,
  upsertSkillFiles,
} from "../be/db";

const TEST_DB_PATH = `./test-skill-files-${process.pid}.sqlite`;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

describe("skill_files storage", () => {
  let skillId: string;

  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
  });

  beforeEach(async () => {
    const db = getDbClient();
    await db.run("DELETE FROM skill_files");
    await db.run("DELETE FROM skills");
    const skill = await createSkill({
      name: `file-skill-${crypto.randomUUID()}`,
      description: "Skill with bundled files",
      content: "---\nname: file-skill\ndescription: Skill with bundled files\n---\n\nBody.",
      type: "personal",
      scope: "agent",
      isComplex: true,
    });
    skillId = skill.id;
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("migration creates skill_files on a fresh DB", async () => {
    const table = await getDbClient().get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_files'",
    );
    expect(table?.name).toBe("skill_files");

    const migration = await getDbClient().get<{ version: number; name: string }>(
      "SELECT version, name FROM _migrations WHERE version = 87",
    );
    expect(migration?.name).toBe("087_skill_files");
  });

  test("re-opening an existing DB keeps skill_files available", async () => {
    closeDb();
    initDb(TEST_DB_PATH);

    const columns = await getDbClient().query<{ name: string }>("PRAGMA table_info(skill_files)");
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "skillId",
      "path",
      "content",
      "mimeType",
      "isBinary",
      "size",
      "createdAt",
      "lastUpdatedAt",
      "created_by",
      "updated_by",
    ]);
  });

  test("upserts, lists manifest without content, fetches, and deletes files", async () => {
    const beforeVersion = (await getDbClient().get<{ version: number }>(
      "SELECT version FROM skills WHERE id = ?",
      [skillId],
    ))!.version;

    const file = await upsertSkillFile(skillId, {
      path: "references/guide.md",
      content: "# Guide",
      mimeType: "text/markdown",
    });
    expect(file.path).toBe("references/guide.md");
    expect(file.size).toBe(Buffer.byteLength("# Guide"));

    const manifest = await listSkillFileManifest(skillId);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).not.toHaveProperty("content");

    expect((await getSkillFile(skillId, "references/guide.md"))?.content).toBe("# Guide");

    const afterVersion = (await getDbClient().get<{ version: number }>(
      "SELECT version FROM skills WHERE id = ?",
      [skillId],
    ))!.version;
    expect(afterVersion).toBeGreaterThan(beforeVersion);

    expect(await deleteSkillFile(skillId, "references/guide.md")).toBe(true);
    expect(await getSkillFile(skillId, "references/guide.md")).toBeNull();
  });

  test("bulk upsert enforces path normalization and stores binary placeholders", async () => {
    const files = await upsertSkillFiles(skillId, [
      {
        path: "references//nested.md",
        content: "nested",
      },
      {
        path: "assets/logo.png",
        content: "",
        mimeType: "image/png",
        isBinary: true,
        size: 1234,
      },
    ]);

    expect(files.map((file) => file.path)).toEqual(["references/nested.md", "assets/logo.png"]);
    const binary = await getSkillFile(skillId, "assets/logo.png");
    expect(binary?.isBinary).toBe(true);
    expect(binary?.content).toBe("[binary file - not synced]");
  });

  test("rejects traversal and SKILL.md rows", async () => {
    expect(() => normalizeSkillFilePath("../secret.md")).toThrow("traversal");
    await expect(
      upsertSkillFile(skillId, {
        path: "SKILL.md",
        content: "nope",
      }),
    ).rejects.toThrow("SKILL.md");
  });

  test("deleting a skill cascades bundled files", async () => {
    const skill = await createSkill({
      name: "cascade-file-skill",
      description: "Cascade test",
      content: "---\nname: cascade-file-skill\ndescription: Cascade test\n---\n\nBody.",
      type: "personal",
      scope: "agent",
      isComplex: true,
    });
    await upsertSkillFile(skill.id, { path: "references/a.md", content: "a" });

    expect(await listSkillFileManifest(skill.id)).toHaveLength(1);
    expect(await deleteSkill(skill.id)).toBe(true);
    expect(await listSkillFileManifest(skill.id)).toHaveLength(0);
  });
});
