/**
 * Retiring a seeded skill whose template was removed.
 *
 * Dropping `templates/skills/<name>/` alone leaves the last seeded row live on
 * every existing install. `retireSeedSkills` deletes it, but only while the
 * seeder still owns it: a recorded `seed_state` hash that the live copy
 * matches. Unrecorded and user-edited skills stay.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  computeContentHash,
  createSkill,
  getSkillByName,
  initDb,
  updateSkill,
} from "../be/db";
import { getSeedState, recordSeedState, runSeeder } from "../be/seed";
import { RETIRED_SEED_SKILLS, retireSeedSkills, skillsSeeder } from "../be/seed-skills";

const TEST_DB_PATH = `./test-seed-skills-retire-${process.pid}.sqlite`;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

/** Seed a file-less swarm skill and record the hash the seeder would have written. */
async function seedLegacySkill(name: string): Promise<string> {
  const content = `---\nname: ${name}\ndescription: old\n---\n\nRun pm2 start.\n`;
  const skill = await createSkill({
    name,
    description: "old",
    content,
    type: "personal",
    scope: "swarm",
    ownerAgentId: undefined,
    systemDefault: false,
  });
  await recordSeedState(
    "skill",
    name,
    computeContentHash(`${content}\n\n# seed:systemDefault=0\n`),
  );
  return skill.id;
}

describe("retiring seeded skills", () => {
  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("artifacts is retired and no longer seeded", async () => {
    expect(RETIRED_SEED_SKILLS).toContain("artifacts");
    const keys = (await skillsSeeder.items()).map((item) => item.key);
    expect(keys).not.toContain("artifacts");
  });

  test("the seeder run deletes a pristine retired skill and its seed state", async () => {
    await seedLegacySkill("artifacts");

    const result = await runSeeder(skillsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.retired).toBe(1);
    expect(await getSkillByName("artifacts", "swarm")).toBeNull();
    expect(await getSeedState("skill", "artifacts")).toBeNull();

    // Settled: nothing left to retire on the next boot.
    expect((await runSeeder(skillsSeeder, { quiet: true })).retired).toBe(0);
  });

  test("a retired skill edited since it was seeded is kept", async () => {
    const id = await seedLegacySkill("zz-retired-edited");
    await updateSkill(id, { content: "---\nname: zz-retired-edited\n---\n\nmine\n" });

    expect(await retireSeedSkills(["zz-retired-edited"])).toEqual([]);
    expect(await getSkillByName("zz-retired-edited", "swarm")).not.toBeNull();
  });

  test("a same-name skill the seeder never recorded is kept", async () => {
    await createSkill({
      name: "zz-retired-unrecorded",
      description: "user authored",
      content: "---\nname: zz-retired-unrecorded\n---\n\nmine\n",
      type: "personal",
      scope: "swarm",
      ownerAgentId: undefined,
      systemDefault: false,
    });

    expect(await retireSeedSkills(["zz-retired-unrecorded"])).toEqual([]);
    expect(await getSkillByName("zz-retired-unrecorded", "swarm")).not.toBeNull();
  });
});
