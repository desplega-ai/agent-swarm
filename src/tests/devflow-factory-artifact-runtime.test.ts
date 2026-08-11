import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevFlowError } from "../devflow/domain/errors";
import type { DevFlowImplementationIntent, DevFlowRepositoryTarget } from "../devflow/domain/types";
import { createGitFactoryArtifactRuntime } from "../devflow/services/factory-artifact-runtime";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

describe("Git Factory artifact runtime", () => {
  let root: string;
  let mirror: string;
  let headSha: string;
  let target: DevFlowRepositoryTarget;
  let intent: DevFlowImplementationIntent;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "devflow-factory-artifacts-"));
    const origin = join(root, "origin.git");
    const author = join(root, "author");
    mirror = join(root, "mirror");
    git(root, "init", "--bare", origin);
    git(root, "init", author);
    git(author, "config", "user.email", "devflow@example.com");
    git(author, "config", "user.name", "DevFlow Test");
    git(author, "remote", "add", "origin", origin);
    await mkdir(join(author, ".dev_harness", "contracts"), { recursive: true });
    await mkdir(join(author, "dev_harness", "factory_queue", "items"), { recursive: true });

    const workItemId = "09ec9bed-47c5-4550-a850-d769d42e8f47";
    const intentId = "2b2d919f-e87a-42bd-b0cd-4f93d9311017";
    const digest = `sha256:${"a".repeat(64)}`;
    await Bun.write(
      join(author, ".dev_harness", "contracts", "devflow_bridge.json"),
      JSON.stringify({
        task: "Implement approved DevFlow intent",
        contract_id: "devflow_bridge",
        canonical_contract_path: ".dev_harness/contracts/devflow_bridge.json",
        queue_item_id: "devflow_bridge",
        owner: "coordinator-agent",
        surfaces: ["dev_harness"],
        impacted_surfaces: [],
        architecture_units: {},
        upstream_authority: {
          system: "devflow",
          work_item_id: workItemId,
          artifact_type: "implementation_intent",
          artifact_id: intentId,
          artifact_version: 1,
          artifact_digest: digest,
        },
        surface_signoffs: [{ surface: "dev_harness", role: "direct", status: "pending" }],
        factory_status: "in_progress",
      }),
    );
    await Bun.write(
      join(author, "dev_harness", "factory_queue", "items", "devflow_bridge.json"),
      JSON.stringify({
        item_id: "devflow_bridge",
        revision: "queue-revision-digest",
        item: {
          id: "devflow_bridge",
          status: "ready",
          surfaces: ["dev_harness"],
          impacted_surfaces: [],
        },
      }),
    );
    git(author, "add", ".");
    git(author, "commit", "-m", "factory intake");
    git(author, "branch", "-M", "codex/devflow-bridge");
    git(author, "push", "-u", "origin", "codex/devflow-bridge");
    headSha = git(author, "rev-parse", "HEAD");
    git(root, "clone", origin, mirror);

    const timestamp = new Date().toISOString();
    target = {
      id: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      name: "Command Center",
      repositoryFullName: "RebarHQ/sequencer_v3",
      defaultBranch: "main",
      executionProfile: "command_center_factory",
      checkoutPath: mirror,
      isActive: true,
      createdAt: timestamp,
      lastUpdatedAt: timestamp,
    };
    intent = {
      id: intentId,
      organizationId: target.organizationId,
      workItemId,
      specId: crypto.randomUUID(),
      specVersion: 1,
      specDigest: digest,
      repositoryTargetId: target.id,
      desiredOutcome: "Create Factory intake",
      priority: "p2",
      riskSummary: "Cross repository",
      intentSnapshot: { schemaVersion: 1 },
      createdByUserId: crypto.randomUUID(),
      createdAt: timestamp,
      lastUpdatedAt: timestamp,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reads and verifies canonical Factory artifacts at the exact pushed revision", () => {
    const snapshot = createGitFactoryArtifactRuntime().inspect({
      target,
      intent,
      candidate: {
        headSha,
        headRef: "codex/devflow-bridge",
        queueItemId: "devflow_bridge",
        contractId: "devflow_bridge",
        canonicalContractPath: ".dev_harness/contracts/devflow_bridge.json",
      },
    });

    expect(snapshot).toMatchObject({
      headSha,
      queueItemRevision: "queue-revision-digest",
      contractId: "devflow_bridge",
      status: "signoff_pending",
      surfaces: ["dev_harness"],
    });
  });

  test("fails closed when the canonical contract digest disagrees", () => {
    const mismatched = { ...intent, specDigest: `sha256:${"b".repeat(64)}` };

    expect(() =>
      createGitFactoryArtifactRuntime().inspect({
        target,
        intent: mismatched,
        candidate: {
          headSha,
          headRef: "codex/devflow-bridge",
          queueItemId: "devflow_bridge",
          contractId: "devflow_bridge",
          canonicalContractPath: ".dev_harness/contracts/devflow_bridge.json",
        },
      }),
    ).toThrow(DevFlowError);
    try {
      createGitFactoryArtifactRuntime().inspect({
        target,
        intent: mismatched,
        candidate: {
          headSha,
          headRef: "codex/devflow-bridge",
          queueItemId: "devflow_bridge",
          contractId: "devflow_bridge",
          canonicalContractPath: ".dev_harness/contracts/devflow_bridge.json",
        },
      });
    } catch (error) {
      expect((error as DevFlowError).errorCode).toBe("factory_upstream_authority_mismatch");
    }
  });

  test("rejects unsafe refs before invoking a fetch", () => {
    expect(() =>
      createGitFactoryArtifactRuntime().inspect({
        target,
        intent,
        candidate: {
          headSha,
          headRef: "../escape",
          queueItemId: "devflow_bridge",
          contractId: "devflow_bridge",
          canonicalContractPath: ".dev_harness/contracts/devflow_bridge.json",
        },
      }),
    ).toThrow("Factory head ref is invalid");
  });
});
