/**
 * Multi-file (bundled) seeded skills.
 *
 * Regression coverage for the collision that shipped `artifacts` twice — once
 * baked into the worker image with an `examples/` directory, once seeded from
 * `templates/skills/` as a simple skill. The DB copy won at runtime, dropped a
 * `.swarm-managed` marker, and the next reconcile pass deleted the baked
 * `examples/*` because those paths had no `skill_files` rows.
 *
 * The invariants that keep that from recurring:
 *   1. Bundled files reach the DB (`skill_files`) when a skill is seeded.
 *   2. Seeded multi-file skills are marked `isComplex` — the FS writer skips
 *      complex skills with zero files, so an unmarked one would sync nothing.
 *   3. Bundled files survive repeated `writeSkillsToFilesystem` passes.
 *   4. Editing a bundled file is detected as a source change.
 *   5. The embedded manifest and the on-disk templates agree.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  computeContentHash,
  deleteSkillFile,
  getSkillByName,
  getSkillFiles,
  initDb,
  updateSkill,
  upsertSkillFile,
} from "../be/db";
import { recordSeedState, runSeeder } from "../be/seed";
import { loadSeedSkills, skillsSeeder } from "../be/seed-skills";
import { type SkillFsEntry, writeSkillsToFilesystem } from "../utils/skill-fs-writer";

const TEST_DB_PATH = `./test-seed-skills-bundled-${process.pid}.sqlite`;
const FAKE_HOME = join(tmpdir(), `seed-skills-bundled-${process.pid}`);
const TEMPLATES_DIR = join(import.meta.dir, "..", "..", "templates", "skills");

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

describe("seeded skills with bundled files", () => {
  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    const result = await runSeeder(skillsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("embedded manifest exposes bundled files for artifacts and pages", async () => {
    const skills = await loadSeedSkills();

    const artifacts = skills.find((skill) => skill.name === "artifacts");
    expect(artifacts?.files.map((file) => file.path).sort()).toEqual([
      "examples/approval-flow.ts",
      "examples/hono-dashboard.ts",
      "examples/multi-artifact.ts",
      "examples/static-report.sh",
    ]);

    const pages = skills.find((skill) => skill.name === "pages");
    expect(pages?.files.map((file) => file.path).sort()).toEqual([
      "examples/annotated-pr.html",
      "examples/report-page.html",
    ]);

    // Simple skills stay simple.
    expect(skills.find((skill) => skill.name === "kv-storage")?.files).toEqual([]);
  });

  test("embedded manifest matches the on-disk templates", async () => {
    const embedded = await loadSeedSkills();
    const fromDisk = await loadSeedSkills(TEMPLATES_DIR);

    for (const name of ["artifacts", "pages"]) {
      const a = embedded.find((skill) => skill.name === name);
      const b = fromDisk.find((skill) => skill.name === name);
      expect(a?.files).toEqual(b?.files ?? []);
    }
  });

  test("generated manifest is not stale relative to templates/", async () => {
    // Mirrors `bun run check:seed-skill-files`, so a contributor who edits a
    // bundled file without regenerating fails here rather than in production.
    const fromDisk = (await loadSeedSkills(TEMPLATES_DIR)).filter(
      (skill) => skill.files.length > 0,
    );
    const embedded = await loadSeedSkills();

    for (const skill of fromDisk) {
      const match = embedded.find((candidate) => candidate.name === skill.name);
      expect(match, `${skill.name} has files on disk but none embedded`).toBeDefined();
      expect(match?.files).toEqual(skill.files);
    }
  });

  test("seeding writes skill_files rows and marks the skill complex", async () => {
    const artifacts = await getSkillByName("artifacts", "swarm");
    expect(artifacts).toBeTruthy();
    if (!artifacts) return;

    expect(artifacts.isComplex).toBe(true);

    const files = await getSkillFiles(artifacts.id);
    expect(files.map((file) => file.path).sort()).toEqual([
      "examples/approval-flow.ts",
      "examples/hono-dashboard.ts",
      "examples/multi-artifact.ts",
      "examples/static-report.sh",
    ]);
    expect(files.every((file) => file.content.length > 0)).toBe(true);
  });

  test("re-running the seeder is a no-op (hash covers bundled files)", async () => {
    const result = await runSeeder(skillsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
  });

  test("a bundled-file edit registers as drift and is preserved", async () => {
    const item = (await skillsSeeder.items()).find((candidate) => candidate.key === "artifacts");
    expect(item).toBeDefined();
    if (!item) return;

    // Freshly seeded and untouched: upstream hashes to exactly the source.
    expect(await skillsSeeder.upstreamHash(item)).toBe(item.contentHash);

    const artifacts = await getSkillByName("artifacts", "swarm");
    if (!artifacts) throw new Error("artifacts skill missing");
    const original = (await getSkillFiles(artifacts.id)).find(
      (file) => file.path === "examples/hono-dashboard.ts",
    );
    if (!original) throw new Error("bundled example missing");

    // Simulate a user editing a bundled file through the skills API.
    await upsertSkillFile(artifacts.id, {
      path: original.path,
      content: `${original.content}\n// edited by a user`,
    });

    // The edit must move the upstream hash — otherwise the seeder would think
    // the skill is pristine and silently clobber the user's file.
    expect(await skillsSeeder.upstreamHash(item)).not.toBe(item.contentHash);

    const result = await runSeeder(skillsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.skippedUserModified).toBeGreaterThan(0);

    const after = (await getSkillFiles(artifacts.id)).find((file) => file.path === original.path);
    expect(after?.content).toContain("// edited by a user");

    // Restore so later tests see a pristine skill.
    await upsertSkillFile(artifacts.id, { path: original.path, content: original.content });
  });

  test("a userInvocable flip registers as drift and is preserved", async () => {
    const item = (await skillsSeeder.items()).find((candidate) => candidate.key === "kv-storage");
    expect(item).toBeDefined();
    if (!item) return;

    expect(await skillsSeeder.upstreamHash(item)).toBe(item.contentHash);

    const skill = await getSkillByName("kv-storage", "swarm");
    if (!skill) throw new Error("kv-storage skill missing");
    expect(skill.userInvocable).toBe(true);

    // Simulate a user turning off slash-invocation through the skills API.
    await updateSkill(skill.id, { userInvocable: false });

    // The flip must move the upstream hash — otherwise the next source update
    // would classify the row as pristine and silently restore userInvocable.
    expect(await skillsSeeder.upstreamHash(item)).not.toBe(item.contentHash);

    // Restore so later tests see a pristine skill.
    await updateSkill(skill.id, { userInvocable: true });
    expect(await skillsSeeder.upstreamHash(item)).toBe(item.contentHash);
  });

  test("upgrades a DB seeded by the previous (file-less) release", async () => {
    // Reproduce the real deployment shape: a skill row that an older release
    // seeded as a SIMPLE skill, with a seed_state hash written in the old
    // format (no bundled-file section). The new seeder must still recognise it
    // as pristine and update it — not misread it as user-modified and skip it
    // forever, which would mean the merged content never reaches production.
    const artifacts = await getSkillByName("artifacts", "swarm");
    if (!artifacts) throw new Error("artifacts skill missing");

    const legacyContent = "---\nname: artifacts\ndescription: old\n---\n\nold body\n";
    await updateSkill(artifacts.id, { content: legacyContent, isComplex: false });
    for (const file of await getSkillFiles(artifacts.id)) {
      await deleteSkillFile(artifacts.id, file.path);
    }

    // Old-format hash: base only, no file section.
    const legacyHash = computeContentHash(`${legacyContent}\n\n# seed:systemDefault=1\n`);
    await recordSeedState("skill", "artifacts", legacyHash);

    const item = (await skillsSeeder.items()).find((candidate) => candidate.key === "artifacts");
    if (!item) throw new Error("artifacts seed item missing");

    // Pristine: upstream (file-less) still hashes in the old format.
    expect(await skillsSeeder.upstreamHash(item)).toBe(legacyHash);

    const result = await runSeeder(skillsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.skippedUserModified).toBe(0);

    const upgraded = await getSkillByName("artifacts", "swarm");
    expect(upgraded?.isComplex).toBe(true);
    expect(upgraded?.content).not.toBe(legacyContent);
    expect((await getSkillFiles(upgraded?.id ?? "")).length).toBe(4);

    // And it settles: the next run is a clean no-op.
    const second = await runSeeder(skillsSeeder, { quiet: true });
    expect(second.updated).toBe(0);
    expect(second.skippedUserModified).toBe(0);
  });

  test("a failed bundled-file write leaves no partial skill row", async () => {
    // Why this matters: if the row landed but file sync then threw, the harness
    // would catch the error and skip recording seed_state. The next boot would
    // see an unrecorded row whose hash — computed over files it does not have —
    // differs from the source, classify it as user-modified, and refuse to
    // touch it again. A system-default skill would stay broken permanently,
    // even after the underlying cause was fixed. apply() runs in a transaction
    // so a failure rolls the row back and the next run retries cleanly.
    //
    // The failure is forced with a bundled path the DB layer rejects
    // (`normalizeSkillFilePath` refuses "SKILL.md" — the body lives on the
    // skill row). That is deterministic and needs no mocking; the file-count
    // and size limits are module-level constants read at import time, so
    // setting SKILL_FILES_MAX_COUNT here would have no effect.
    const name = "zz-atomic-probe";
    expect(await getSkillByName(name, "swarm")).toBeNull();

    const poisoned = {
      key: name,
      contentHash: "probe",
      skill: {
        name,
        description: "atomicity probe",
        content: `---\nname: ${name}\ndescription: atomicity probe\n---\n\nbody\n`,
        systemDefault: false,
        files: [
          { path: "examples/fine.ts", content: "// this one is valid" },
          { path: "SKILL.md", content: "// rejected: reserved path" },
        ],
      },
    };

    await expect(skillsSeeder.apply(poisoned, "create")).rejects.toThrow();

    // The row must not survive the failed file write...
    expect(await getSkillByName(name, "swarm")).toBeNull();
    // ...and neither must the file that was written before the bad one.
    expect((await getSkillFiles(poisoned.key)).length).toBe(0);
  });

  test("bundled files survive repeated filesystem syncs (the reconcile bug)", async () => {
    const artifacts = await getSkillByName("artifacts", "swarm");
    expect(artifacts).toBeTruthy();
    if (!artifacts) return;

    const entry: SkillFsEntry = {
      id: artifacts.id,
      name: artifacts.name,
      content: artifacts.content,
      isComplex: artifacts.isComplex,
      isEnabled: true,
      isActive: true,
      files: (await getSkillFiles(artifacts.id)).map((file) => ({
        path: file.path,
        content: file.content,
        isBinary: file.isBinary,
      })),
    };

    // Pass 1 writes SKILL.md, the bundled files, and the .swarm-managed marker.
    writeSkillsToFilesystem([entry], "claude", FAKE_HOME);
    const examplePath = join(
      FAKE_HOME,
      ".claude",
      "skills",
      "artifacts",
      "examples",
      "hono-dashboard.ts",
    );
    expect(existsSync(examplePath)).toBe(true);

    // Pass 2 runs reconcile with the marker present. Before bundled-file
    // seeding, skill_files was empty here and this pass deleted examples/*.
    writeSkillsToFilesystem([entry], "claude", FAKE_HOME);
    expect(existsSync(examplePath)).toBe(true);
    expect(readFileSync(examplePath, "utf-8").length).toBeGreaterThan(0);

    // And a third, to prove it's stable rather than merely delayed.
    writeSkillsToFilesystem([entry], "claude", FAKE_HOME);
    expect(existsSync(examplePath)).toBe(true);

    // Now demonstrate the defect this test guards against, so the assertions
    // above can't pass vacuously. Re-syncing the SAME skill as a *simple* one
    // (what the DB held before bundled-file seeding) reconciles the marked
    // directory against an empty file set and prunes the examples.
    const asSimpleSkill: SkillFsEntry = { ...entry, isComplex: false, files: [] };
    writeSkillsToFilesystem([asSimpleSkill], "claude", FAKE_HOME);
    expect(existsSync(examplePath)).toBe(false);

    // ...and syncing the complex form again restores them.
    writeSkillsToFilesystem([entry], "claude", FAKE_HOME);
    expect(existsSync(examplePath)).toBe(true);
  });
});
