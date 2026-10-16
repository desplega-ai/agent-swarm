/**
 * Retiring a seeded skill whose template was removed.
 *
 * Dropping `templates/skills/<name>/` alone leaves the last seeded row live on
 * every existing install. `retireSeedSkills` deletes it, but only while the
 * seeder still owns it: a recorded `seed_state` hash that the live copy
 * matches and every metadata column still holds what the seeder wrote.
 * Unrecorded and user-edited skills stay, including metadata-only edits.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  computeContentHash,
  createAgent,
  createSkill,
  getAgentSkills,
  getSkillByName,
  getSkillFiles,
  initDb,
  installSkill,
  updateSkill,
  upsertSkillFiles,
} from "../be/db";
import { getSeedState, recordSeedState, runSeeder } from "../be/seed";
import { RETIRED_SEED_SKILLS, retireSeedSkills, skillsSeeder } from "../be/seed-skills";

const TEST_DB_PATH = `./test-seed-skills-retire-${process.pid}.sqlite`;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

const BUNDLED_FILE = { path: "examples/serve.ts", content: "pm2 start serve.ts\n" };

/**
 * Seed a swarm skill the way the seeder does (frontmatter description equal to
 * the description column, isComplex set from the file count) and record the
 * hash it would have written.
 */
async function seedLegacySkill(name: string, withFile = false): Promise<string> {
  const content = `---\nname: ${name}\ndescription: old\n---\n\nRun pm2 start.\n`;
  const skill = await createSkill({
    name,
    description: "old",
    content,
    type: "personal",
    scope: "swarm",
    ownerAgentId: undefined,
    systemDefault: false,
    isComplex: withFile,
  });
  let hashed = `${content}\n\n# seed:systemDefault=0\n`;
  if (withFile) {
    await upsertSkillFiles(skill.id, [BUNDLED_FILE]);
    hashed += `# seed:files\n${BUNDLED_FILE.path}\n${BUNDLED_FILE.content}\n`;
  }
  await recordSeedState("skill", name, computeContentHash(hashed));
  return skill.id;
}

describe("retiring seeded skills", () => {
  let agentId: string;

  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    agentId = (
      await createAgent({ name: "retire-test", isLead: false, status: "idle", capabilities: [] })
    ).id;
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
    const id = await seedLegacySkill("artifacts", true);
    await installSkill(agentId, id);

    const result = await runSeeder(skillsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.retired).toBe(1);
    expect(await getSkillByName("artifacts", "swarm")).toBeNull();
    expect(await getSkillFiles(id)).toEqual([]);
    expect((await getAgentSkills(agentId, false)).map((s) => s.id)).not.toContain(id);
    expect(await getSeedState("skill", "artifacts")).toBeNull();

    // Settled: nothing left to retire on the next boot.
    expect((await runSeeder(skillsSeeder, { quiet: true })).retired).toBe(0);
  });

  test("the seeder run keeps a retired skill with metadata-only edits, with its installs and files", async () => {
    const id = await seedLegacySkill("artifacts", true);
    await installSkill(agentId, id);
    await updateSkill(id, {
      allowedTools: "Read",
      model: "user-selected-model",
      description: "my edited description",
    });

    const result = await runSeeder(skillsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.retired).toBe(0);

    const kept = await getSkillByName("artifacts", "swarm");
    expect(kept?.id).toBe(id);
    expect(kept?.model).toBe("user-selected-model");
    expect((await getSkillFiles(id)).map((file) => file.path)).toEqual([BUNDLED_FILE.path]);
    expect((await getAgentSkills(agentId, false)).map((s) => s.id)).toContain(id);
  });

  // Every column updateSkill can write outside the seed hash. Each one alone
  // marks the row as user-edited.
  const METADATA_EDITS: [string, Parameters<typeof updateSkill>[1]][] = [
    ["description", { description: "mine" }],
    ["allowedTools", { allowedTools: "Read" }],
    ["model", { model: "opus" }],
    ["effort", { effort: "high" }],
    ["context", { context: "fork" }],
    ["agent", { agent: "reviewer" }],
    ["disableModelInvocation", { disableModelInvocation: true }],
    ["isEnabled", { isEnabled: false }],
    ["isComplex", { isComplex: true }],
    ["sourceUrl", { sourceUrl: "https://example.com/SKILL.md" }],
    ["sourceRepo", { sourceRepo: "me/skills" }],
    ["sourcePath", { sourcePath: "skills/artifacts" }],
    ["sourceBranch", { sourceBranch: "dev" }],
    ["sourceHash", { sourceHash: "abc123" }],
    ["lastFetchedAt", { lastFetchedAt: "2026-01-01T00:00:00.000Z" }],
  ];

  test.each(METADATA_EDITS)("a retired skill with an edited %s is kept", async (field, edit) => {
    const name = `zz-retired-meta-${field.toLowerCase()}`;
    const id = await seedLegacySkill(name);
    await updateSkill(id, edit);

    expect(await retireSeedSkills([name])).toEqual([]);
    expect(await getSkillByName(name, "swarm")).not.toBeNull();
  });

  test("a pristine retired skill touched by a no-op update is still retired", async () => {
    const id = await seedLegacySkill("zz-retired-noop");
    await updateSkill(id, {});

    expect(await retireSeedSkills(["zz-retired-noop"])).toEqual(["zz-retired-noop"]);
    expect(await getSkillByName("zz-retired-noop", "swarm")).toBeNull();
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
