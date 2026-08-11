import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createUser, getDb, initDb } from "../be/db";
import type { DevFlowContext } from "../devflow/domain/types";
import { createDevFlowRepository, type DevFlowRepository } from "../devflow/repository";
import {
  canonicalStringify,
  createImplementationIntentService,
} from "../devflow/services/implementation-intent-service";

const TEST_DB_PATH = "./test-devflow-implementation-intent.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("DevFlow implementation intent service", () => {
  let repo: DevFlowRepository;
  let context: DevFlowContext;
  let workItemId: string;
  let targetId: string;

  beforeAll(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    repo = createDevFlowRepository(getDb());
    const user = createUser({ name: "PM", email: "intent-pm@example.com" });
    const org = repo.createOrganization({ name: "Intent Org", slug: "intent-org" });
    repo.addMembership({ organizationId: org.id, userId: user.id, role: "pm" });
    context = { organizationId: org.id, actorKind: "user", actorId: user.id };
    const item = repo.createWorkItem({
      organizationId: org.id,
      title: "Governed bridge",
      description: "Create one immutable implementation intent.",
      priority: "p2",
      createdVia: "manual",
      pmOwnerId: user.id,
    });
    workItemId = item.id;
    repo.upsertScope(org.id, item.id, {
      problemStatement: "Specs need governed repository execution.",
      targetUsers: ["product", "engineering"],
      successCriteria: ["Factory contract is digest linked"],
      effortBand: "m",
      openQuestions: [],
      confidence: 0.9,
      rationale: "Command Center already owns implementation governance.",
    });
    repo.signOffScope(org.id, item.id, new Date().toISOString());
    repo.createSpecVersion(org.id, item.id, {
      problemStatement: "Approved DevFlow specs must enter the Factory.",
      userStories: "As a PM, I can send an approved spec to Command Center.",
      outOfScope: "Deployment and monitoring",
      uxBehavior: "Show verified Factory receipts.",
      dataModelChanges: "Persist immutable intent and execution observations.",
      integrationPoints: "Agent Swarm task and Factory contract.",
      threatModel: "Reject tenant, path, digest, and revision mismatches.",
      rollbackPlan: "Cancel future bridge work without deleting Factory evidence.",
      dependencyMap: ["Factory upstream authority support"],
      openQuestions: [],
      acceptanceCriteria: [
        {
          given: "an approved spec",
          when: "it is sent to the Factory",
          // biome-ignore lint/suspicious/noThenProperty: Acceptance criteria use Given/When/Then terminology.
          then: "the contract carries the matching digest",
          isTestable: true,
        },
      ],
      nfrDeclarations: [],
    });
    const approvedAt = new Date().toISOString();
    repo.approveCurrentSpec(org.id, item.id, approvedAt);
    repo.createGateDecision({
      organizationId: org.id,
      workItemId: item.id,
      gate: 2,
      decision: "approved",
      actorUserId: user.id,
      actorRole: "pm",
      rationale: "Spec is ready for implementation intake.",
      preconditionSnapshot: { specApproved: true },
    });
    repo.updateWorkItem(org.id, item.id, { state: "specced" });
    targetId = repo.createRepositoryTarget({
      organizationId: org.id,
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

  test("canonical JSON is independent of object key insertion order", () => {
    expect(canonicalStringify({ b: 2, nested: { z: 3, a: 1 }, a: [2, 1] })).toBe(
      canonicalStringify({ a: [2, 1], nested: { a: 1, z: 3 }, b: 2 }),
    );
  });

  test("creates one immutable digest-linked intent from Gate 2 authority", () => {
    const service = createImplementationIntentService(repo);
    const input = {
      repositoryTargetId: targetId,
      desiredOutcome: "Create a reviewed implementation contract.",
      riskSummary: "Cross-repository orchestration",
    };
    const first = service.create(context, workItemId, input);
    const repeated = service.create(context, workItemId, input);

    expect(first.specDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(repeated.id).toBe(first.id);
    expect(first.intentSnapshot).toMatchObject({
      schemaVersion: 1,
      workItem: { id: workItemId, state: "specced" },
      repositoryTarget: { id: targetId, repositoryFullName: "RebarHQ/sequencer_v3" },
      gate2: { decision: "approved" },
    });
    expect(repo.listAuditEvents(context.organizationId, workItemId)[0]?.action).toBe(
      "implementation_intent.created",
    );
  });

  test("fails closed without a current approved spec and Gate 2 decision", () => {
    const user = createUser({ name: "Other PM", email: "intent-other@example.com" });
    const org = repo.createOrganization({ name: "Other Intent Org", slug: "other-intent-org" });
    repo.addMembership({ organizationId: org.id, userId: user.id, role: "pm" });
    const item = repo.createWorkItem({
      organizationId: org.id,
      title: "Unapproved",
      description: "No spec",
      createdVia: "manual",
      pmOwnerId: user.id,
    });
    const target = repo.createRepositoryTarget({
      organizationId: org.id,
      name: "Other Command Center",
      repositoryFullName: "RebarHQ/other",
      checkoutPath: "/srv/devflow/repos/other",
    });

    expect(() =>
      createImplementationIntentService(repo).create(
        { organizationId: org.id, actorKind: "user", actorId: user.id },
        item.id,
        {
          repositoryTargetId: target.id,
          desiredOutcome: "Must fail",
          riskSummary: "Missing authority",
        },
      ),
    ).toThrow("approved Gate 2 spec");
  });
});
