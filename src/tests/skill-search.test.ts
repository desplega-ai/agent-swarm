import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createSkill, initDb, searchSkills } from "../be/db";

const TEST_DB_PATH = `./test-skill-search-${process.pid}.sqlite`;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

describe("searchSkills", () => {
  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);

    await createSkill({
      name: "call-time-trap-placement",
      description: "Decide where operational rules belong.",
      content: "Use toolsMd and claudeMd to document the delivery surface.",
      scope: "swarm",
    });
    await createSkill({
      name: "content-search-example",
      description: "A skill with a content-only term.",
      content: "This body contains the needle-token.",
      scope: "swarm",
    });
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("matches every whitespace-separated token across searchable fields", async () => {
    const skills = await searchSkills("call-time trap placement toolsMd claudeMd delivery surface");

    expect(skills.map((skill) => skill.name)).toContain("call-time-trap-placement");
  });

  test("matches terms that appear only in content", async () => {
    const skills = await searchSkills("needle-token");

    expect(skills.map((skill) => skill.name)).toEqual(["content-search-example"]);
  });

  test("returns no results when any token matches nothing", async () => {
    const skills = await searchSkills("call-time nonexistent-token");

    expect(skills).toEqual([]);
  });

  test("keeps single-word searches working", async () => {
    const skills = await searchSkills("call-time");

    expect(skills.map((skill) => skill.name)).toContain("call-time-trap-placement");
  });
});
