import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { type AriaHqRepository, createAriaHqRepository } from "../ariahq/repository";
import {
  createKnowledgeService,
  type KnowledgeAnswerTaskRuntime,
  type KnowledgeService,
} from "../ariahq/services/knowledge-service";
import { closeDb, createTaskExtended, createUser, getDb, initDb } from "../be/db";
import { createDevFlowRepository } from "../devflow/repository";

const TEST_DB_PATH = "./test-ariahq-knowledge-service.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("AriaHQ Organizational Brain", () => {
  let repo: AriaHqRepository;
  let service: KnowledgeService;
  let organizationId: string;
  let userId: string;
  const prompts: string[] = [];

  beforeAll(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    repo = createAriaHqRepository(getDb());
    const devflow = createDevFlowRepository(getDb());
    userId = createUser({ name: "Brain User", email: "brain-user@example.com" }).id;
    organizationId = devflow.createOrganization({ name: "Rebar", slug: "brain-rebar" }).id;
    devflow.addMembership({ organizationId, userId, role: "admin" });

    const runtime: KnowledgeAnswerTaskRuntime = {
      create(prompt, options) {
        prompts.push(prompt);
        return createTaskExtended(prompt, options);
      },
    };
    service = createKnowledgeService({ repo, taskRuntime: runtime });
  });

  afterAll(async () => {
    closeDb();
    await removeTestDb();
  });

  beforeEach(async () => {
    // The prompt-template resolver tests clear the shared process registry.
    // Re-register AriaHQ templates so full-suite file ordering cannot turn a
    // governed answer prompt into an empty task body.
    await import(`../ariahq/prompts?t=${Date.now()}`);
  });

  test("evidence bundles preserve authority order and render auditable citations", () => {
    repo.ingestKnowledge({
      organizationId,
      kind: "source_evidence",
      sourceKind: "call_recording",
      sourceRef: "gong:call:17",
      sourceRevision: "2",
      sourceUrl: "https://example.test/calls/17",
      audience: "internal",
      title: "Renewal date discussion",
      content: "The Rentvine renewal date discussed on the call was September 30.",
      verificationStatus: "raw",
      effectiveAt: "2026-08-10T15:00:00.000Z",
      metadata: {},
    });
    const canonical = repo.ingestKnowledge({
      organizationId,
      kind: "canonical_fact",
      sourceKind: "crm",
      sourceRef: "hubspot:deal:77",
      sourceRevision: "9",
      sourceUrl: "https://example.test/deals/77",
      audience: "internal",
      title: "Renewal date",
      content: "The Rentvine renewal date is September 30.",
      verificationStatus: "verified",
      effectiveAt: "2026-08-11T12:00:00.000Z",
      metadata: {},
    });

    const bundle = service.buildEvidenceBundle(
      { organizationId, actorKind: "user", actorId: userId, audience: "internal" },
      "What is the Rentvine renewal date?",
      { now: "2026-08-11T13:00:00.000Z" },
    );

    expect(bundle.evidence[0]?.recordId).toBe(canonical.id);
    expect(bundle.evidence[0]?.citation).toContain(`[${canonical.id}]`);
    expect(bundle.evidence[0]?.citation).toContain("hubspot:deal:77");
    expect(bundle.evidence[0]?.citation).toContain("verified");
    expect(bundle.evidence[0]?.citation).toContain("https://example.test/deals/77");
  });

  test("conflicting verified facts remain visible and force explicit conflict handling", () => {
    repo.ingestKnowledge({
      organizationId,
      kind: "canonical_fact",
      sourceKind: "manual",
      sourceRef: "contract:rentvine:2026",
      sourceRevision: "1",
      audience: "internal",
      title: "Renewal date",
      content: "The Rentvine renewal date is October 15.",
      verificationStatus: "conflicted",
      effectiveAt: "2026-08-11T12:30:00.000Z",
      metadata: {},
    });

    const result = service.startAnswer(
      { organizationId, actorKind: "user", actorId: userId, audience: "internal" },
      "What is the Rentvine renewal date?",
      { now: "2026-08-11T13:00:00.000Z" },
    );

    expect(result.status).toBe("dispatched");
    expect(result.bundle.hasConflict).toBe(true);
    expect(result.bundle.evidence.some((item) => item.verificationStatus === "conflicted")).toBe(
      true,
    );
    expect(prompts.at(-1)).toContain("STATE THE CONFLICT EXPLICITLY");
  });

  test("client answers are restricted to the exact tenant boundary", () => {
    repo.ingestKnowledge({
      organizationId,
      kind: "source_evidence",
      sourceKind: "slack",
      sourceRef: "slack:C-CLIENT:1",
      sourceRevision: "1",
      audience: "client",
      clientKey: "rentvine",
      title: "Bulk reassignment status",
      content: "Bulk reassignment is being reviewed by the product team.",
      verificationStatus: "verified",
      effectiveAt: "2026-08-11T12:00:00.000Z",
      metadata: {},
    });

    const allowed = service.buildEvidenceBundle(
      {
        organizationId,
        actorKind: "external",
        actorId: "U-CLIENT",
        audience: "client",
        clientKey: "rentvine",
      },
      "What is the bulk reassignment status?",
    );
    const denied = service.startAnswer(
      {
        organizationId,
        actorKind: "external",
        actorId: "U-OTHER",
        audience: "client",
        clientKey: "another-client",
      },
      "What is the bulk reassignment status?",
    );

    expect(allowed.evidence).toHaveLength(1);
    expect(denied.status).toBe("abstained");
    expect(denied.message).toContain("do not have sufficient authorized evidence");
  });

  test("no evidence abstains without dispatching an answer task", () => {
    const before = prompts.length;
    const result = service.startAnswer(
      { organizationId, actorKind: "user", actorId: userId, audience: "internal" },
      "What is the launch date for Project Nebula?",
    );

    expect(result.status).toBe("abstained");
    expect(result.taskId).toBeUndefined();
    expect(prompts).toHaveLength(before);
  });
});
