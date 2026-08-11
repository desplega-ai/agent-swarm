import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createUser, getDb, initDb } from "../be/db";
import { createDevFlowRepository, type DevFlowRepository } from "../devflow/repository";

const TEST_DB_PATH = "./test-devflow-repository.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("DevFlow repository", () => {
  let repo: DevFlowRepository;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    repo = createDevFlowRepository(getDb());
    userAId = createUser({ name: "PM A", email: "pm-a@example.com" }).id;
    userBId = createUser({ name: "PM B", email: "pm-b@example.com" }).id;
  });

  afterAll(async () => {
    closeDb();
    await removeTestDb();
  });

  test("lists only the requested organization's work items", () => {
    const orgA = repo.createOrganization({ id: crypto.randomUUID(), name: "A", slug: "a" });
    const orgB = repo.createOrganization({ id: crypto.randomUUID(), name: "B", slug: "b" });
    repo.addMembership({
      organizationId: orgA.id,
      userId: userAId,
      role: "pm",
    });
    repo.addMembership({
      organizationId: orgB.id,
      userId: userBId,
      role: "pm",
    });

    repo.createWorkItem({
      organizationId: orgA.id,
      title: "Visible",
      description: "Tenant A item",
      createdVia: "manual",
      pmOwnerId: userAId,
    });
    repo.createWorkItem({
      organizationId: orgB.id,
      title: "Hidden",
      description: "Tenant B item",
      createdVia: "manual",
      pmOwnerId: userBId,
    });

    expect(repo.listWorkItems(orgA.id, {}).items.map((item) => item.title)).toEqual(["Visible"]);
    expect(repo.listWorkItems(orgB.id, {}).items.map((item) => item.title)).toEqual(["Hidden"]);
  });

  test("cannot resolve a foreign-organization work item", () => {
    const orgA = repo.getOrganizationBySlug("a");
    const orgB = repo.getOrganizationBySlug("b");
    expect(orgA).not.toBeNull();
    expect(orgB).not.toBeNull();
    const itemA = repo.listWorkItems(orgA!.id, {}).items[0];
    expect(itemA).toBeDefined();
    expect(repo.getWorkItem(orgB!.id, itemA!.id)).toBeNull();
  });

  test("rejects membership for an unknown user", () => {
    const org = repo.getOrganizationBySlug("a");
    expect(org).not.toBeNull();
    expect(() =>
      repo.addMembership({
        organizationId: org!.id,
        userId: crypto.randomUUID(),
        role: "viewer",
      }),
    ).toThrow();
  });
});
