import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createUser, getDb, initDb } from "../be/db";
import { type DevFlowContext, type DevFlowState, NFR_CATEGORIES } from "../devflow/domain/types";
import { createDevFlowRepository, type DevFlowRepository } from "../devflow/repository";
import {
  createTransitionService,
  type DevFlowTransitionService,
} from "../devflow/services/transition-service";

const TEST_DB_PATH = "./test-devflow-transition.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("DevFlow transition service", () => {
  let repo: DevFlowRepository;
  let service: DevFlowTransitionService;
  let organizationId: string;
  let pmId: string;
  let leadId: string;
  let viewerId: string;
  let itemId: string;

  beforeEach(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    repo = createDevFlowRepository(getDb());
    service = createTransitionService(repo);
    organizationId = repo.createOrganization({ name: "Tenant Zero", slug: "tenant-zero" }).id;
    pmId = createUser({ name: "PM", email: "pm@example.com" }).id;
    leadId = createUser({ name: "Lead", email: "lead@example.com" }).id;
    viewerId = createUser({ name: "Viewer", email: "viewer@example.com" }).id;
    repo.addMembership({ organizationId, userId: pmId, role: "pm" });
    repo.addMembership({ organizationId, userId: leadId, role: "engineering_lead" });
    repo.addMembership({ organizationId, userId: viewerId, role: "viewer" });
    itemId = repo.createWorkItem({
      organizationId,
      title: "Export report",
      description: "Customers need CSV export.",
      createdVia: "manual",
      pmOwnerId: pmId,
    }).id;
  });

  afterEach(async () => {
    closeDb();
    await removeTestDb();
  });

  function context(actorId: string, actorKind: DevFlowContext["actorKind"] = "user") {
    return { organizationId, actorKind, actorId } satisfies DevFlowContext;
  }

  function setState(state: DevFlowState): void {
    repo.updateWorkItem(organizationId, itemId, { state });
  }

  function saveScope(): void {
    repo.upsertScope(organizationId, itemId, {
      problemStatement: "Teams cannot export reports.",
      targetUsers: ["Operations manager"],
      successCriteria: ["CSV download completes"],
      effortBand: "m",
      openQuestions: [],
      confidence: 0.9,
      rationale: "Clear customer request",
    });
  }

  function saveReadySpec(overrides: { threatModel?: string; testable?: boolean } = {}): void {
    repo.createSpecVersion(organizationId, itemId, {
      problemStatement: "Teams cannot export reports.",
      outOfScope: "Scheduled exports",
      uxBehavior: "Export button downloads a CSV.",
      dataModelChanges: "None",
      integrationPoints: "Reports API",
      threatModel: overrides.threatModel,
      dependencyMap: [],
      openQuestions: [],
      acceptanceCriteria: [
        {
          given: "a report with rows",
          when: "the user exports CSV",
          // biome-ignore lint/suspicious/noThenProperty: Test fixture models a Given/When/Then criterion.
          then: "a valid CSV downloads",
          isTestable: overrides.testable ?? true,
        },
      ],
      nfrDeclarations: NFR_CATEGORIES.map((category) => ({
        category,
        status: "addressed" as const,
        statement: `${category} is covered`,
      })),
    });
    repo.updateWorkItem(organizationId, itemId, { blastRadius: "low" });
  }

  test("advances captured to triaged from agent evidence", () => {
    repo.updateWorkItem(organizationId, itemId, {
      type: "feature",
      classificationRationale: "A concrete product capability",
    });
    const result = service.transition(context("intake-agent", "agent"), itemId, {
      toState: "triaged",
      rationale: "Intake classification complete",
    });
    expect(result).toMatchObject({ fromState: "captured", toState: "triaged" });
    expect(repo.listAuditEvents(organizationId, itemId)[0]?.action).toBe("work_item.triaged");
  });

  test("Gate 1 signs off scope and records an approval atomically", () => {
    setState("triaged");
    saveScope();
    service.transition(context(pmId), itemId, { toState: "scoped", rationale: "Scope approved" });
    expect(repo.getWorkItem(organizationId, itemId)?.state).toBe("scoped");
    expect(repo.getScope(organizationId, itemId)?.pmSignedOffAt).toBeDefined();
    expect(repo.listGateDecisions(organizationId, itemId)).toHaveLength(1);
  });

  test("Gate 1 rejects a viewer without changing state or audit", () => {
    setState("triaged");
    saveScope();
    const beforeAudit = repo.listAuditEvents(organizationId, itemId).length;
    expect(() =>
      service.transition(context(viewerId), itemId, {
        toState: "scoped",
        rationale: "I should not approve",
      }),
    ).toThrow("PM role");
    expect(repo.getWorkItem(organizationId, itemId)?.state).toBe("triaged");
    expect(repo.listAuditEvents(organizationId, itemId)).toHaveLength(beforeAudit);
  });

  test("Gate 2 rejects untestable acceptance criteria", () => {
    setState("scoped");
    saveReadySpec({ testable: false });
    expect(() =>
      service.transition(context(leadId), itemId, {
        toState: "specced",
        rationale: "Review complete",
      }),
    ).toThrow("testable");
    expect(repo.getWorkItem(organizationId, itemId)?.state).toBe("scoped");
    expect(repo.listGateDecisions(organizationId, itemId)).toHaveLength(0);
  });

  test("Gate 2 requires a threat model for security-sensitive work", () => {
    setState("scoped");
    saveReadySpec();
    repo.updateWorkItem(organizationId, itemId, { isSecuritySensitive: true });
    expect(() =>
      service.transition(context(leadId), itemId, {
        toState: "specced",
        rationale: "Review complete",
      }),
    ).toThrow("threat model");
  });

  test("Gate 2 approves a complete spec", () => {
    setState("scoped");
    saveReadySpec();
    service.transition(context(leadId), itemId, {
      toState: "specced",
      rationale: "Engineering review complete",
    });
    expect(repo.getWorkItem(organizationId, itemId)?.state).toBe("specced");
    expect(repo.getCurrentSpec(organizationId, itemId)?.status).toBe("approved");
    expect(repo.listGateDecisions(organizationId, itemId)[0]?.gate).toBe(2);
  });

  test("blocked items return only to their recorded prior state", () => {
    setState("scoped");
    service.transition(context(pmId), itemId, {
      toState: "blocked",
      rationale: "Waiting on API access",
      blockerReason: "Missing sandbox credentials",
    });
    expect(repo.getWorkItem(organizationId, itemId)).toMatchObject({
      state: "blocked",
      previousState: "scoped",
    });
    service.transition(context(pmId), itemId, {
      toState: "scoped",
      rationale: "Credentials received",
    });
    expect(repo.getWorkItem(organizationId, itemId)?.state).toBe("scoped");
  });

  test("rejects disabled later-stage transitions", () => {
    setState("specced");
    expect(() =>
      service.transition(context(leadId), itemId, { toState: "sized", rationale: "Premature" }),
    ).toThrow("not enabled");
  });
});
