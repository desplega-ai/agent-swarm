import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createTaskExtended, createUser, getDb, initDb } from "../be/db";
import { createDevFlowRepository, type DevFlowRepository } from "../devflow/repository";

const TEST_DB_PATH = "./test-devflow-factory-repository.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("DevFlow Factory repository", () => {
  let repo: DevFlowRepository;
  let orgAId: string;
  let orgBId: string;
  let itemAId: string;
  let specAId: string;
  let targetAId: string;

  beforeAll(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    repo = createDevFlowRepository(getDb());
    const userA = createUser({ name: "PM A", email: "factory-pm-a@example.com" });
    const userB = createUser({ name: "PM B", email: "factory-pm-b@example.com" });
    const orgA = repo.createOrganization({ name: "Factory A", slug: "factory-a" });
    const orgB = repo.createOrganization({ name: "Factory B", slug: "factory-b" });
    orgAId = orgA.id;
    orgBId = orgB.id;
    repo.addMembership({ organizationId: orgAId, userId: userA.id, role: "pm" });
    repo.addMembership({ organizationId: orgBId, userId: userB.id, role: "pm" });
    const item = repo.createWorkItem({
      organizationId: orgAId,
      title: "Factory bridge",
      description: "Send an approved spec to the Factory",
      createdVia: "manual",
      pmOwnerId: userA.id,
    });
    itemAId = item.id;
    const spec = repo.createSpecVersion(orgAId, item.id, {
      problemStatement: "Implementation intent must enter the governed Factory.",
      outOfScope: "Deployment",
      uxBehavior: "Show verified Factory status.",
      dataModelChanges: "Repository target and execution receipts.",
      integrationPoints: "Agent Swarm and Command Center Factory.",
      dependencyMap: [],
      openQuestions: [],
      acceptanceCriteria: [],
      nfrDeclarations: [],
    });
    specAId = spec.id;
    targetAId = repo.createRepositoryTarget({
      organizationId: orgAId,
      name: "Command Center",
      repositoryFullName: "RebarHQ/sequencer_v3",
      defaultBranch: "main",
      checkoutPath: "/srv/devflow/repos/sequencer_v3",
    }).id;
  });

  afterAll(async () => {
    closeDb();
    await removeTestDb();
  });

  test("repository targets are tenant isolated", () => {
    expect(repo.getRepositoryTarget(orgAId, targetAId)?.repositoryFullName).toBe(
      "RebarHQ/sequencer_v3",
    );
    expect(repo.getRepositoryTarget(orgBId, targetAId)).toBeNull();
    expect(repo.listRepositoryTargets(orgBId)).toEqual([]);
  });

  test("implementation intents are immutable and unique for an exact authority", () => {
    const input = {
      organizationId: orgAId,
      workItemId: itemAId,
      specId: specAId,
      specVersion: 1,
      specDigest: `sha256:${"a".repeat(64)}`,
      repositoryTargetId: targetAId,
      desiredOutcome: "Create a governed implementation contract.",
      priority: "p2" as const,
      riskSummary: "Contract schema change",
      intentSnapshot: { workItem: { id: itemAId }, spec: { id: specAId, version: 1 } },
      createdByUserId: repo.listWorkItems(orgAId, {}).items[0]!.pmOwnerId,
    };
    const intent = repo.createImplementationIntent(input);

    expect(repo.getImplementationIntent(orgAId, intent.id)?.intentSnapshot).toEqual(
      input.intentSnapshot,
    );
    expect(repo.getImplementationIntent(orgBId, intent.id)).toBeNull();
    expect(() => repo.createImplementationIntent(input)).toThrow();
  });

  test("foreign-organization associations fail closed", () => {
    expect(() =>
      repo.createImplementationIntent({
        organizationId: orgBId,
        workItemId: itemAId,
        specId: specAId,
        specVersion: 1,
        specDigest: `sha256:${"b".repeat(64)}`,
        repositoryTargetId: targetAId,
        desiredOutcome: "Cross tenant",
        priority: "p3",
        riskSummary: "Must fail",
        intentSnapshot: {},
        createdByUserId: repo.listWorkItems(orgAId, {}).items[0]!.pmOwnerId,
      }),
    ).toThrow();
  });

  test("Factory execution observations update without erasing prior authority", () => {
    const intent = repo.listImplementationIntents(orgAId, itemAId)[0]!;
    const execution = repo.createFactoryExecution({
      organizationId: orgAId,
      implementationIntentId: intent.id,
    });
    const swarmTask = createTaskExtended("Create canonical Factory intake", {
      source: "api",
    });
    const updated = repo.updateFactoryExecution(orgAId, execution.id, {
      status: "signoff_pending",
      swarmTaskId: swarmTask.id,
      headSha: "c".repeat(40),
      queueItemId: "devflow-bridge",
      contractId: "devflow-bridge-contract",
      canonicalContractPath: ".dev_harness/contracts/devflow-bridge-contract.json",
      factoryStatus: "in_progress",
      surfaces: ["dev_harness"],
      signoffs: [{ surface: "dev_harness", status: "pending" }],
      lastObservedAt: new Date().toISOString(),
    });

    expect(updated.implementationIntentId).toBe(intent.id);
    expect(updated.status).toBe("signoff_pending");
    expect(updated.surfaces).toEqual(["dev_harness"]);
    expect(repo.getFactoryExecution(orgBId, execution.id)).toBeNull();
    expect(() =>
      repo.createFactoryExecution({ organizationId: orgAId, implementationIntentId: intent.id }),
    ).toThrow();
  });
});
