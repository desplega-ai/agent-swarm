/**
 * Coverage for the bundle's snapshot ordering.
 *
 * The worker caches the signature it receives from the bundle and only
 * refreshes when a later probe differs. If the signature were taken after the
 * file reads, an edit landing in between would ship stale file content under
 * the newer hash and the worker would never refresh again.
 */
import { describe, expect, test } from "bun:test";
import { buildSkillsBundle, computeSkillsSignature } from "../be/skill-sync";
import type { SkillFile, SkillWithInstallInfo } from "../types";

function makeSkill(overrides: Partial<SkillWithInstallInfo> = {}): SkillWithInstallInfo {
  return {
    id: "skill-1",
    name: "alpha",
    description: "first",
    content: "# Alpha",
    type: "personal",
    scope: "swarm",
    ownerAgentId: null,
    sourceUrl: null,
    sourceRepo: null,
    sourcePath: null,
    sourceBranch: "main",
    sourceHash: null,
    isComplex: true,
    allowedTools: null,
    model: null,
    effort: null,
    context: null,
    version: 1,
    isEnabled: true,
    systemDefault: false,
    createdAt: "2026-01-01T00:00:00Z",
    lastUpdatedAt: "2026-01-01T00:00:00Z",
    isActive: true,
    installedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  } as SkillWithInstallInfo;
}

function makeFile(): SkillFile {
  return {
    id: "file-1",
    skillId: "skill-1",
    path: "refs/notes.md",
    content: "notes",
    mimeType: "text/markdown",
    isBinary: false,
    size: 5,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } as SkillFile;
}

describe("buildSkillsBundle", () => {
  test("signs the rows it returns even when an edit lands during the file read", async () => {
    let rows = [makeSkill()];
    let edited = false;

    const bundle = await buildSkillsBundle(
      async () => rows.map((row) => ({ ...row })),
      async () => {
        // An edit interleaves with the bundle read, after the rows were read.
        edited = true;
        rows = [
          {
            ...rows[0]!,
            description: "edited",
            lastUpdatedAt: "2026-10-22T00:00:00Z",
          },
        ];
        return [makeFile()];
      },
    );

    expect(edited).toBe(true);
    // The payload carries the pre-edit rows, so the signature must describe
    // those rows — not the post-edit state that a second read would see.
    expect(bundle.signature).toBe(computeSkillsSignature(bundle.skills).hash);
    expect(bundle.signature).not.toBe(computeSkillsSignature(rows).hash);
    expect(bundle.skills[0]?.description).toBe("first");
  });

  test("a simple skill carries no bundled files and needs no file read", async () => {
    let fileReads = 0;
    const bundle = await buildSkillsBundle(
      async () => [makeSkill({ id: "skill-2", name: "beta", isComplex: false })],
      async () => {
        fileReads++;
        return [makeFile()];
      },
    );

    expect(fileReads).toBe(0);
    expect(bundle.skills[0]?.files).toEqual([]);
  });
});
