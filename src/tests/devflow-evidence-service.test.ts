import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createUser, getDb, initDb } from "../be/db";
import { type DevFlowAgentMode, NFR_CATEGORIES } from "../devflow/domain/types";
import { createDevFlowRepository, type DevFlowRepository } from "../devflow/repository";
import {
  createEvidenceService,
  type DevFlowEvidenceService,
} from "../devflow/services/evidence-service";
import { createTransitionService } from "../devflow/services/transition-service";

const TEST_DB_PATH = "./test-devflow-evidence.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("DevFlow evidence service", () => {
  let repo: DevFlowRepository;
  let evidence: DevFlowEvidenceService;
  let organizationId: string;
  let itemId: string;

  beforeEach(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    repo = createDevFlowRepository(getDb());
    evidence = createEvidenceService(repo, createTransitionService(repo));
    const pmId = createUser({ name: "PM", email: "pm@example.com" }).id;
    organizationId = repo.createOrganization({ name: "Tenant Zero", slug: "tenant-zero" }).id;
    repo.addMembership({ organizationId, userId: pmId, role: "pm" });
    itemId = repo.createWorkItem({
      organizationId,
      title: "Raw request",
      description: "Please export this report.",
      createdVia: "manual",
      pmOwnerId: pmId,
    }).id;
  });

  afterEach(async () => {
    closeDb();
    await removeTestDb();
  });

  function createRun(mode: DevFlowAgentMode) {
    return repo.createAgentRun({
      organizationId,
      workItemId: itemId,
      mode,
      status: "running",
      contractVersion: "1.0.0",
      promptVersion: "1.0.0",
    });
  }

  function intakeFixture() {
    return {
      classification: "feature",
      title: "Export report as CSV",
      description: "Operations teams need a CSV export.",
      suggestedPriority: "p2",
      duplicateOf: null,
      duplicateConfidence: 0.05,
      okrLinks: [],
      isSecuritySensitiveSignal: false,
      customerSignalPresent: true,
      rationale: "This is a concrete product capability.",
    };
  }

  test("valid intake evidence advances a captured item to triaged", () => {
    const run = createRun("intake");
    evidence.applyAgentEvidence(
      { organizationId, actorKind: "agent", actorId: "intake-agent" },
      run.id,
      intakeFixture(),
    );
    expect(repo.getWorkItem(organizationId, itemId)).toMatchObject({
      state: "triaged",
      type: "feature",
      title: "Export report as CSV",
      priority: "p2",
    });
    expect(repo.getAgentRun(organizationId, run.id)).toMatchObject({
      status: "succeeded",
      evidenceAppliedAt: expect.any(String),
    });
  });

  test("noise evidence is retained without advancing lifecycle", () => {
    const run = createRun("intake");
    evidence.applyAgentEvidence(
      { organizationId, actorKind: "agent", actorId: "intake-agent" },
      run.id,
      { ...intakeFixture(), classification: "noise" },
    );
    expect(repo.getWorkItem(organizationId, itemId)?.state).toBe("captured");
    expect(repo.getAgentRun(organizationId, run.id)?.status).toBe("succeeded");
  });

  test("scope evidence creates the editable draft without auto-approving Gate 1", () => {
    repo.updateWorkItem(organizationId, itemId, { state: "triaged" });
    const run = createRun("scope");
    evidence.applyAgentEvidence(
      { organizationId, actorKind: "agent", actorId: "scope-agent" },
      run.id,
      {
        problemStatement: "Teams cannot export report data.",
        targetUsers: ["Operations manager"],
        successCriteria: ["CSV downloads successfully"],
        effortBand: "m",
        openQuestions: ["Should filters apply?"],
        confidence: 0.88,
        rationale: "The request and user are explicit.",
      },
    );
    expect(repo.getScope(organizationId, itemId)).toMatchObject({
      problemStatement: "Teams cannot export report data.",
      effortBand: "m",
      agentRunId: run.id,
    });
    expect(repo.getWorkItem(organizationId, itemId)?.state).toBe("triaged");
  });

  test("spec evidence creates AC and all nine NFR records", () => {
    repo.updateWorkItem(organizationId, itemId, { state: "scoped" });
    const run = createRun("spec");
    const nfrDeclarations = Object.fromEntries(
      NFR_CATEGORIES.map((category) => [
        category,
        { status: "addressed", statement: `${category} covered` },
      ]),
    );
    evidence.applyAgentEvidence(
      { organizationId, actorKind: "agent", actorId: "spec-agent" },
      run.id,
      {
        acClauses: [
          {
            given: "a populated report",
            when: "the user selects Export CSV",
            // biome-ignore lint/suspicious/noThenProperty: Test fixture models a Given/When/Then criterion.
            then: "a valid CSV downloads",
            isTestable: true,
            testHint: "API integration test",
          },
        ],
        nfrDeclarations,
        uxBehavior: "Show Export CSV in report actions.",
        dataModelChanges: "None",
        integrationPoints: "Reports API",
        outOfScope: "Scheduled exports",
        openQuestions: [],
        blastRadius: "low",
        threatModel: null,
        confidence: 0.9,
      },
    );
    const spec = repo.getCurrentSpec(organizationId, itemId);
    expect(spec?.acceptanceCriteria).toHaveLength(1);
    expect(spec?.nfrDeclarations).toHaveLength(9);
    expect(repo.getWorkItem(organizationId, itemId)?.blastRadius).toBe("low");
  });

  test("invalid evidence marks the run failed without creating artifacts", () => {
    repo.updateWorkItem(organizationId, itemId, { state: "scoped" });
    const run = createRun("spec");
    expect(() =>
      evidence.applyAgentEvidence(
        { organizationId, actorKind: "agent", actorId: "spec-agent" },
        run.id,
        { acClauses: [] },
      ),
    ).toThrow("evidence validation failed");
    expect(repo.getCurrentSpec(organizationId, itemId)).toBeNull();
    expect(repo.getAgentRun(organizationId, run.id)).toMatchObject({ status: "failed" });
    expect(repo.getWorkItem(organizationId, itemId)?.state).toBe("scoped");
  });
});
