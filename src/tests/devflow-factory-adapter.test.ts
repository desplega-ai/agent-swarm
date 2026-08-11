import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createTaskExtended, createUser, getDb, initDb } from "../be/db";
import type { DevFlowContext, DevFlowImplementationIntent } from "../devflow/domain/types";
import { createDevFlowRepository, type DevFlowRepository } from "../devflow/repository";
import {
  createFactoryAdapter,
  type FactoryTaskCreateOptions,
  type FactoryTaskRecord,
  type FactoryTaskRuntime,
} from "../devflow/services/factory-adapter";

const TEST_DB_PATH = "./test-devflow-factory-adapter.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("DevFlow Factory adapter", () => {
  let repo: DevFlowRepository;
  let context: DevFlowContext;
  let intent: DevFlowImplementationIntent;
  let task: FactoryTaskRecord;
  let capturedOptions: FactoryTaskCreateOptions | undefined;
  let taskRuntime: FactoryTaskRuntime;

  beforeEach(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    repo = createDevFlowRepository(getDb());
    const user = createUser({ name: "PM", email: `adapter-${crypto.randomUUID()}@example.com` });
    const org = repo.createOrganization({ name: "Adapter Org", slug: crypto.randomUUID() });
    repo.addMembership({ organizationId: org.id, userId: user.id, role: "pm" });
    context = { organizationId: org.id, actorKind: "user", actorId: user.id };
    const item = repo.createWorkItem({
      organizationId: org.id,
      title: "Factory adapter",
      description: "Dispatch governed implementation",
      createdVia: "manual",
      pmOwnerId: user.id,
    });
    const spec = repo.createSpecVersion(org.id, item.id, {
      problemStatement: "Dispatch",
      outOfScope: "Deploy",
      uxBehavior: "Readback",
      dataModelChanges: "Intent",
      integrationPoints: "Factory",
      dependencyMap: [],
      openQuestions: [],
      acceptanceCriteria: [],
      nfrDeclarations: [],
    });
    const target = repo.createRepositoryTarget({
      organizationId: org.id,
      name: "Command Center",
      repositoryFullName: "RebarHQ/sequencer_v3",
      checkoutPath: "/srv/devflow/repos/sequencer_v3",
    });
    intent = repo.createImplementationIntent({
      organizationId: org.id,
      workItemId: item.id,
      specId: spec.id,
      specVersion: spec.version,
      specDigest: `sha256:${"a".repeat(64)}`,
      repositoryTargetId: target.id,
      desiredOutcome: "Create Factory intake",
      priority: "p2",
      riskSummary: "Cross repository",
      intentSnapshot: { schemaVersion: 1 },
      createdByUserId: user.id,
    });
    const storedTask = createTaskExtended("placeholder", { source: "api" });
    task = { id: storedTask.id, status: "unassigned" };
    taskRuntime = {
      create(_prompt, options) {
        capturedOptions = options;
        return task;
      },
      get() {
        return task;
      },
    };
  });

  afterEach(async () => {
    closeDb();
    await removeTestDb();
  });

  test("dispatches one repository-aware task with a strict candidate schema", () => {
    const adapter = createFactoryAdapter({
      repo,
      taskRuntime,
      artifactRuntime: { inspect: () => expect.unreachable() },
    });
    const first = adapter.startExecution(context, intent.id);
    const repeated = adapter.startExecution(context, intent.id);

    expect(repeated.id).toBe(first.id);
    expect(capturedOptions).toMatchObject({
      taskType: "devflow-factory-intake",
      vcsProvider: "github",
      vcsRepo: "RebarHQ/sequencer_v3",
      modelTier: "smart",
      effort: "high",
      contextKey: `devflow:${context.organizationId}:factory:${intent.id}`,
    });
    expect(capturedOptions?.outputSchema).toMatchObject({
      additionalProperties: false,
      required: ["headSha", "headRef", "queueItemId", "contractId", "canonicalContractPath"],
    });
  });

  test("reconciles only the independently verified artifact snapshot", () => {
    const adapter = createFactoryAdapter({
      repo,
      taskRuntime,
      artifactRuntime: {
        inspect: () => ({
          headSha: "c".repeat(40),
          queueItemId: "devflow_bridge",
          queueItemRevision: "revision-digest",
          contractId: "devflow_bridge",
          canonicalContractPath: ".dev_harness/contracts/devflow_bridge.json",
          factoryStatus: "in_progress",
          status: "ready",
          surfaces: ["dev_harness"],
          impactedSurfaces: [],
          architectureUnits: {},
          signoffs: [{ surface: "dev_harness", status: "approved" }],
          artifacts: {},
        }),
      },
    });
    const execution = adapter.startExecution(context, intent.id);
    task = {
      ...task,
      status: "completed",
      output: JSON.stringify({
        headSha: "c".repeat(40),
        headRef: "codex/devflow-bridge",
        queueItemId: "devflow_bridge",
        contractId: "devflow_bridge",
        canonicalContractPath: ".dev_harness/contracts/devflow_bridge.json",
      }),
    };

    const reconciled = adapter.reconcileExecution(context, execution.id);

    expect(reconciled.status).toBe("ready");
    expect(reconciled.queueItemRevision).toBe("revision-digest");
    expect(reconciled.contractId).toBe("devflow_bridge");
  });

  test("invalid completed task output fails without creating Factory truth", () => {
    const adapter = createFactoryAdapter({
      repo,
      taskRuntime,
      artifactRuntime: { inspect: () => expect.unreachable() },
    });
    const execution = adapter.startExecution(context, intent.id);
    task = { ...task, status: "completed", output: "not json" };

    const reconciled = adapter.reconcileExecution(context, execution.id);

    expect(reconciled.status).toBe("failed");
    expect(reconciled.failureCode).toBe("factory_evidence_invalid");
    expect(reconciled.contractId).toBeUndefined();
  });
});
