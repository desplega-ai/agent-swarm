import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createWorkflow,
  getWorkflowVersion,
  getWorkflowVersions,
  initDb,
  updateWorkflow,
} from "../be/db";
import type { Workflow } from "../types";
import { snapshotWorkflow } from "../workflows/version";

const TEST_DB_PATH = "./test-workflow-versions.sqlite";

// ─── Setup ──────────────────────────────────────────────────

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

// ─── Helpers ────────────────────────────────────────────────

function makeWorkflow(name?: string): Workflow {
  return createWorkflow({
    name: name ?? `test-wf-${crypto.randomUUID().slice(0, 8)}`,
    definition: {
      nodes: [
        {
          id: "n1",
          type: "notify",
          config: { channel: "swarm", template: "v1" },
        },
      ],
    },
  });
}

// ─── Tests ──────────────────────────────────────────────────

describe("snapshotWorkflow", () => {
  test("creates a version snapshot with correct version number", () => {
    const workflow = makeWorkflow();

    const version = snapshotWorkflow(workflow.id);

    expect(version.workflowId).toBe(workflow.id);
    expect(version.version).toBe(1);
    expect(version.snapshot.name).toBe(workflow.name);
    expect(version.snapshot.definition).toEqual(workflow.definition);
    expect(version.snapshot.triggers).toEqual([]);
    expect(version.snapshot.enabled).toBe(true);
    expect(version.createdAt).toBeDefined();
  });

  test("version numbers increment on successive snapshots", () => {
    const workflow = makeWorkflow();

    const v1 = snapshotWorkflow(workflow.id);
    expect(v1.version).toBe(1);

    // Update workflow between snapshots
    updateWorkflow(workflow.id, { description: "updated once" });

    const v2 = snapshotWorkflow(workflow.id);
    expect(v2.version).toBe(2);

    updateWorkflow(workflow.id, { description: "updated twice" });

    const v3 = snapshotWorkflow(workflow.id);
    expect(v3.version).toBe(3);
  });

  test("snapshot contains full workflow state at time of capture", () => {
    const workflow = makeWorkflow();

    // Take snapshot of initial state
    const v1 = snapshotWorkflow(workflow.id);
    expect(v1.snapshot.description).toBeUndefined();

    // Update workflow
    updateWorkflow(workflow.id, {
      description: "has description now",
      triggers: [{ type: "webhook", hmacSecret: "secret" }],
      cooldown: { minutes: 30 },
    });

    // Take snapshot after update
    const v2 = snapshotWorkflow(workflow.id);
    expect(v2.snapshot.description).toBe("has description now");
    expect(v2.snapshot.triggers).toEqual([{ type: "webhook", hmacSecret: "secret" }]);
    expect(v2.snapshot.cooldown).toEqual({ minutes: 30 });
  });

  test("changedByAgentId is recorded when provided", () => {
    const workflow = makeWorkflow();
    const agentId = crypto.randomUUID();

    const version = snapshotWorkflow(workflow.id, agentId);

    expect(version.changedByAgentId).toBe(agentId);
  });

  test("throws when workflow does not exist", () => {
    expect(() => {
      snapshotWorkflow("00000000-0000-0000-0000-000000000000");
    }).toThrow("Workflow 00000000-0000-0000-0000-000000000000 not found");
  });
});

describe("getWorkflowVersions", () => {
  test("returns versions in descending order", () => {
    const workflow = makeWorkflow();

    snapshotWorkflow(workflow.id);
    updateWorkflow(workflow.id, { description: "update 1" });
    snapshotWorkflow(workflow.id);
    updateWorkflow(workflow.id, { description: "update 2" });
    snapshotWorkflow(workflow.id);

    const versions = getWorkflowVersions(workflow.id);

    expect(versions.length).toBe(3);
    expect(versions[0]!.version).toBe(3);
    expect(versions[1]!.version).toBe(2);
    expect(versions[2]!.version).toBe(1);
  });

  test("returns empty array for workflow with no versions", () => {
    const workflow = makeWorkflow();
    const versions = getWorkflowVersions(workflow.id);
    expect(versions).toEqual([]);
  });
});

describe("getWorkflowVersion", () => {
  test("returns specific version by number", () => {
    const workflow = makeWorkflow();

    snapshotWorkflow(workflow.id);
    updateWorkflow(workflow.id, { description: "v2 state" });
    snapshotWorkflow(workflow.id);

    const v1 = getWorkflowVersion(workflow.id, 1);
    expect(v1).not.toBeNull();
    expect(v1!.version).toBe(1);
    expect(v1!.snapshot.description).toBeUndefined();

    const v2 = getWorkflowVersion(workflow.id, 2);
    expect(v2).not.toBeNull();
    expect(v2!.version).toBe(2);
    expect(v2!.snapshot.description).toBe("v2 state");
  });

  test("returns null for non-existent version", () => {
    const workflow = makeWorkflow();
    const result = getWorkflowVersion(workflow.id, 999);
    expect(result).toBeNull();
  });
});

describe("version history workflow (snapshot before update)", () => {
  test("full update cycle: create -> snapshot -> update -> snapshot -> update -> verify history", () => {
    const workflow = makeWorkflow("versioned-workflow");

    // Snapshot before first update (captures initial state)
    snapshotWorkflow(workflow.id);
    updateWorkflow(workflow.id, {
      description: "first update",
      definition: {
        nodes: [
          {
            id: "n1",
            type: "notify",
            config: { channel: "swarm", template: "v2" },
          },
        ],
      },
    });

    // Snapshot before second update
    snapshotWorkflow(workflow.id);
    updateWorkflow(workflow.id, {
      description: "second update",
    });

    // Verify version history
    const versions = getWorkflowVersions(workflow.id);
    expect(versions.length).toBe(2);

    // v1 should have the initial state (no description)
    const v1 = versions.find((v) => v.version === 1)!;
    expect(v1.snapshot.description).toBeUndefined();
    expect(v1.snapshot.definition.nodes[0]!.config.template).toBe("v1");

    // v2 should have the first update state
    const v2 = versions.find((v) => v.version === 2)!;
    expect(v2.snapshot.description).toBe("first update");
    expect(v2.snapshot.definition.nodes[0]!.config.template).toBe("v2");
  });
});
