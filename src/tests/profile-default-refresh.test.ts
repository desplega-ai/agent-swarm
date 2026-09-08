import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  createAgent,
  getAgentById,
  getLatestContextVersion,
  initDb,
  updateAgentProfile,
} from "../be/db";
import { getBasePrompt } from "../prompts/base-prompt";
import {
  generateDefaultClaudeMd,
  generateDefaultIdentityMd,
  matchesDefaultClaudeMd,
  matchesDefaultIdentityMd,
} from "../prompts/defaults";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "profile-default-refresh-"));
  initDb(join(directory, "test.sqlite"));
});
afterAll(async () => {
  closeDb();
  await rm(directory, { recursive: true, force: true });
});

async function seedProfile() {
  const id = crypto.randomUUID();
  const metadata = {
    name: `Worker ${id}`,
    description: "Original description",
    role: "worker",
    capabilities: ["typescript"],
  };
  await createAgent({ id, name: metadata.name, isLead: false, status: "idle" });
  const profile = {
    ...metadata,
    identityMd: generateDefaultIdentityMd(metadata),
    claudeMd: generateDefaultClaudeMd(metadata),
  };
  await updateAgentProfile(id, profile);
  return { id, ...profile };
}

describe("profile metadata default refresh", () => {
  test.each([
    { description: "New description" },
    { name: "Renamed worker" },
    { description: "" },
    { role: "reviewer", capabilities: [] },
  ])("regenerates defaults for %j and persists their classification", async (updates) => {
    const previous = await seedProfile();
    const updated = await updateAgentProfile(previous.id, updates);
    expect(updated).not.toBeNull();
    if (!updated) throw new Error("Agent disappeared");
    expect(updated.identityMd).toBe(generateDefaultIdentityMd(updated));
    expect(updated.claudeMd).toBe(generateDefaultClaudeMd(updated));
    // A fresh read has no runner history, just like boot after a restart.
    const persisted = await getAgentById(previous.id);
    expect(persisted).toEqual(updated);
    if (!persisted) throw new Error("Agent disappeared");
    expect(matchesDefaultIdentityMd(persisted.identityMd ?? "", persisted)).toBe(true);
    expect(matchesDefaultClaudeMd(persisted.claudeMd ?? "", persisted)).toBe(true);
    expect((await getLatestContextVersion(previous.id, "identityMd"))?.content).toBe(
      updated.identityMd,
    );
    expect((await getLatestContextVersion(previous.id, "claudeMd"))?.content).toBe(
      updated.claudeMd,
    );
    const prompt = await getBasePrompt({
      ...persisted,
      agentId: persisted.id,
      role: persisted.role ?? "worker",
      provider: "pi",
    });
    expect(prompt).not.toContain("## About");
    expect(prompt).not.toContain("Operational notes that persist across sessions.");
    if (updates.description !== undefined) {
      expect(prompt).not.toContain("Original description");
      if (updates.description) expect(prompt).toContain(updates.description);
    }
  });

  test("preserves edits within interpolated regions and explicit clears", async () => {
    const previous = await seedProfile();
    const custom = previous.identityMd.replace("Original description", "My custom About text");
    await updateAgentProfile(previous.id, { identityMd: custom });
    const updated = await updateAgentProfile(previous.id, {
      description: "New description",
      claudeMd: "",
    });
    expect(updated?.identityMd).toBe(custom);
    expect(updated?.claudeMd).toBe("");
  });

  test("preserves custom notes and explicit identity writes", async () => {
    const previous = await seedProfile();
    const custom = `${previous.claudeMd}\nAlways test before pushing.`;
    await updateAgentProfile(previous.id, { claudeMd: custom });
    const updated = await updateAgentProfile(previous.id, {
      description: "New description",
      identityMd: "Explicit replacement identity",
    });
    expect(updated?.identityMd).toBe("Explicit replacement identity");
    expect(updated?.claudeMd).toBe(custom);
  });

  test("serializes concurrent metadata edits without leaving stale defaults", async () => {
    const previous = await seedProfile();
    await Promise.all([
      updateAgentProfile(previous.id, { description: "Concurrent description" }),
      updateAgentProfile(previous.id, { name: "Concurrent name" }),
    ]);
    const updated = await getAgentById(previous.id);
    if (!updated) throw new Error("Agent disappeared");
    expect(updated.description).toBe("Concurrent description");
    expect(updated.name).toBe("Concurrent name");
    expect(updated.identityMd).toBe(generateDefaultIdentityMd(updated));
    expect(updated.claudeMd).toBe(generateDefaultClaudeMd(updated));
  });
});
