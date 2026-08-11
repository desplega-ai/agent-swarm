import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeDb, createUser, getDb, initDb } from "../be/db";
import { createDevFlowRepository, type DevFlowRepository } from "../devflow/repository";
import { createTransitionService } from "../devflow/services/transition-service";
import { handleDevFlow } from "../http/devflow";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { User } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-devflow-http.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

function makeServer(users: Map<string, User>): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const userId = req.headers["x-test-user-id"] as string | undefined;
    const user = userId ? users.get(userId) : undefined;
    setRequestAuth(req, user ? { kind: "user", userId: user.id, user } : null);
    const handled = await handleDevFlow(
      req,
      res,
      getPathSegments(req.url ?? ""),
      parseQueryParams(req.url ?? ""),
    );
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("DevFlow HTTP API", () => {
  let repo: DevFlowRepository;
  let server: Server;
  let baseUrl: string;
  let pm: User;
  let other: User;
  let orgA: string;
  let orgB: string;

  beforeEach(async () => {
    await removeTestDb();
    initDb(TEST_DB_PATH);
    repo = createDevFlowRepository(getDb());
    pm = createUser({ name: "PM", email: "http-pm@example.com" });
    other = createUser({ name: "Other", email: "http-other@example.com" });
    orgA = repo.createOrganization({ name: "A", slug: "http-a" }).id;
    orgB = repo.createOrganization({ name: "B", slug: "http-b" }).id;
    repo.addMembership({ organizationId: orgA, userId: pm.id, role: "pm" });
    repo.addMembership({ organizationId: orgB, userId: other.id, role: "pm" });
    server = makeServer(
      new Map([
        [pm.id, pm],
        [other.id, other],
      ]),
    );
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    await removeTestDb();
  });

  function headers(userId: string, organizationId: string): HeadersInit {
    return {
      "content-type": "application/json",
      "x-test-user-id": userId,
      "x-devflow-organization-id": organizationId,
    };
  }

  test("captures, lists, and resolves work items only inside the selected tenant", async () => {
    const createdResponse = await fetch(`${baseUrl}/api/devflow/v1/work-items`, {
      method: "POST",
      headers: headers(pm.id, orgA),
      body: JSON.stringify({
        title: "Tenant A request",
        description: "Only A can see this.",
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { item: { id: string } };

    const listA = await fetch(`${baseUrl}/api/devflow/v1/work-items`, {
      headers: headers(pm.id, orgA),
    });
    expect((await listA.json()) as { total: number }).toMatchObject({
      total: 1,
    });

    const foreignRead = await fetch(`${baseUrl}/api/devflow/v1/work-items/${created.item.id}`, {
      headers: headers(other.id, orgB),
    });
    expect(foreignRead.status).toBe(404);
    expect(await foreignRead.json()).toMatchObject({ error_code: "not_found" });
  });

  test("saves scope and approves Gate 1 through the role-checked transition endpoint", async () => {
    const item = repo.createWorkItem({
      organizationId: orgA,
      title: "Scoped request",
      description: "Needs a clear outcome.",
      createdVia: "manual",
      pmOwnerId: pm.id,
    });
    repo.updateWorkItem(orgA, item.id, {
      classificationRationale: "Concrete feature",
    });
    createTransitionService(repo).transition(
      { organizationId: orgA, actorKind: "system", actorId: "test" },
      item.id,
      { toState: "triaged", rationale: "Classified" },
    );

    const scopeResponse = await fetch(`${baseUrl}/api/devflow/v1/work-items/${item.id}/scope`, {
      method: "PUT",
      headers: headers(pm.id, orgA),
      body: JSON.stringify({
        problemStatement: "Operators cannot export a report.",
        targetUsers: ["Operations"],
        successCriteria: ["A CSV downloads in under five seconds"],
        effortBand: "s",
        openQuestions: [],
        confidence: 0.9,
        rationale: "The boundary is narrow.",
      }),
    });
    expect(scopeResponse.status).toBe(200);

    const transitionResponse = await fetch(
      `${baseUrl}/api/devflow/v1/work-items/${item.id}/transitions`,
      {
        method: "POST",
        headers: headers(pm.id, orgA),
        body: JSON.stringify({
          toState: "scoped",
          rationale: "Scope approved",
        }),
      },
    );
    expect(transitionResponse.status).toBe(200);
    expect(await transitionResponse.json()).toMatchObject({
      item: { id: item.id, state: "scoped" },
      scope: { pmSignedOffAt: expect.any(String) },
    });
  });

  test("configures tenant-scoped Factory targets without exposing server checkout paths", async () => {
    const response = await fetch(`${baseUrl}/api/devflow/v1/repository-targets`, {
      method: "POST",
      headers: headers(pm.id, orgA),
      body: JSON.stringify({
        name: "Command Center",
        repositoryFullName: "RebarHQ/sequencer_v3",
        defaultBranch: "main",
        checkoutPath: "/srv/devflow/repos/sequencer_v3",
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { targets: Record<string, unknown>[] };
    expect(body.targets[0]).toMatchObject({
      name: "Command Center",
      repositoryFullName: "RebarHQ/sequencer_v3",
      executionProfile: "command_center_factory",
    });
    expect(body.targets[0]).not.toHaveProperty("checkoutPath");

    const foreignList = await fetch(`${baseUrl}/api/devflow/v1/repository-targets`, {
      headers: headers(other.id, orgB),
    });
    expect(await foreignList.json()).toEqual({ targets: [] });
  });

  test("turns Gate 2 authority into one immutable intent and queued Factory execution", async () => {
    const item = repo.createWorkItem({
      organizationId: orgA,
      title: "Factory bridge",
      description: "Execute an approved spec through Command Center.",
      priority: "p2",
      createdVia: "manual",
      pmOwnerId: pm.id,
    });
    repo.upsertScope(orgA, item.id, {
      problemStatement: "Approved specs need governed implementation.",
      targetUsers: ["Product", "Engineering"],
      successCriteria: ["Factory intake is digest linked"],
      effortBand: "m",
      openQuestions: [],
      confidence: 0.9,
      rationale: "Use the existing Factory authority.",
    });
    repo.signOffScope(orgA, item.id, new Date().toISOString());
    repo.createSpecVersion(orgA, item.id, {
      problemStatement: "Approved specs need governed implementation.",
      userStories: "As a PM, I can send an approved spec to Factory.",
      outOfScope: "Deployment",
      uxBehavior: "Show Factory evidence.",
      dataModelChanges: "Persist the intent and execution.",
      integrationPoints: "Agent Swarm and Command Center Factory.",
      threatModel: "Fail closed on authority mismatches.",
      rollbackPlan: "Stop future dispatches.",
      dependencyMap: [],
      openQuestions: [],
      acceptanceCriteria: [
        {
          given: "an approved spec",
          when: "the PM sends it to Factory",
          // biome-ignore lint/suspicious/noThenProperty: Acceptance criteria use Given/When/Then terminology.
          then: "one linked execution is queued",
          isTestable: true,
        },
      ],
      nfrDeclarations: [],
    });
    repo.approveCurrentSpec(orgA, item.id, new Date().toISOString());
    repo.createGateDecision({
      organizationId: orgA,
      workItemId: item.id,
      gate: 2,
      decision: "approved",
      actorUserId: pm.id,
      actorRole: "pm",
      rationale: "Approved for implementation.",
      preconditionSnapshot: { specApproved: true },
    });
    repo.updateWorkItem(orgA, item.id, { state: "specced" });
    const target = repo.createRepositoryTarget({
      organizationId: orgA,
      name: "Command Center",
      repositoryFullName: "RebarHQ/sequencer_v3",
      checkoutPath: "/srv/devflow/repos/sequencer_v3",
    });

    const response = await fetch(
      `${baseUrl}/api/devflow/v1/work-items/${item.id}/implementation-intents`,
      {
        method: "POST",
        headers: headers(pm.id, orgA),
        body: JSON.stringify({
          repositoryTargetId: target.id,
          desiredOutcome: "Create reviewed Factory intake.",
          riskSummary: "Cross-repository orchestration",
        }),
      },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      intents: Array<{ id: string; specDigest: string }>;
      executions: Array<{ status: string; swarmTaskId?: string }>;
    };
    expect(body.intents[0]?.specDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.executions[0]).toMatchObject({
      status: "queued",
      swarmTaskId: expect.any(String),
    });

    const list = await fetch(
      `${baseUrl}/api/devflow/v1/work-items/${item.id}/implementation-intents`,
      { headers: headers(pm.id, orgA) },
    );
    expect(await list.json()).toMatchObject({
      intents: [{ id: body.intents[0]?.id }],
      executions: [{ status: "queued" }],
    });
  });
});
