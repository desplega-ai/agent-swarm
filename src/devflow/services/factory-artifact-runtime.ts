import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { DevFlowError } from "../domain/errors";
import {
  FactoryContractSnapshotSchema,
  FactoryQueueSnapshotSchema,
  type FactoryTaskCandidate,
  type VerifiedFactorySnapshot,
} from "../domain/factory-contracts";
import type { DevFlowImplementationIntent, DevFlowRepositoryTarget } from "../domain/types";

export interface FactoryInspectionInput {
  target: DevFlowRepositoryTarget;
  intent: DevFlowImplementationIntent;
  candidate: FactoryTaskCandidate;
}

export interface FactoryArtifactRuntime {
  inspect(input: FactoryInspectionInput): VerifiedFactorySnapshot;
}

const MAX_GIT_OUTPUT_BYTES = 1_048_576;
const SAFE_HEAD_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;

function fail(code: string, message: string): never {
  throw new DevFlowError(409, code, message);
}

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const stdout = result.stdout ?? new Uint8Array();
  const stderr = result.stderr ?? new Uint8Array();
  if (stdout.byteLength > MAX_GIT_OUTPUT_BYTES || stderr.byteLength > MAX_GIT_OUTPUT_BYTES) {
    fail("factory_git_output_too_large", "Factory Git output exceeded the safe limit.");
  }
  if (result.exitCode !== 0) {
    fail("factory_git_read_failed", "Unable to read the exact Factory revision.");
  }
  return new TextDecoder().decode(stdout).trim();
}

function readRegularGitFile(cwd: string, revision: string, path: string): string {
  const listing = runGit(cwd, ["ls-tree", revision, "--", path]);
  const mode = listing.split(/\s+/, 1)[0];
  if (mode !== "100644" && mode !== "100755") {
    fail("factory_artifact_not_regular", "Factory artifact must be a regular Git file.");
  }
  return runGit(cwd, ["show", `${revision}:${path}`]);
}

function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    fail(code, "Factory artifact did not contain valid JSON.");
  }
}

function deriveStatus(
  factoryStatus: string,
  signoffs: unknown[],
  finalizerAdmission: Record<string, unknown> | undefined,
): VerifiedFactorySnapshot["status"] {
  const statuses = signoffs
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => String(entry.status ?? "pending"));
  if (statuses.some((status) => !["approved", "waived", "checks"].includes(status))) {
    return "signoff_pending";
  }
  if (finalizerAdmission) return "finalizer_admitted";
  if (factoryStatus === "in_progress") return statuses.length ? "ready" : "factory_intake";
  return "ready";
}

export function createGitFactoryArtifactRuntime(): FactoryArtifactRuntime {
  return {
    inspect({ target, intent, candidate }) {
      if (
        !SAFE_HEAD_REF.test(candidate.headRef) ||
        candidate.headRef.includes("..") ||
        candidate.headRef.includes("@{")
      ) {
        fail("factory_head_ref_invalid", "Factory head ref is invalid.");
      }
      const checkout = realpathSync(resolve(target.checkoutPath));
      const repositoryRoot = realpathSync(
        resolve(runGit(checkout, ["rev-parse", "--show-toplevel"])),
      );
      if (repositoryRoot !== checkout) {
        fail("factory_checkout_mismatch", "Repository target is not the configured Git root.");
      }
      runGit(checkout, ["fetch", "--no-tags", "--depth=1", "origin", candidate.headRef]);
      const fetchedHead = runGit(checkout, ["rev-parse", "FETCH_HEAD"]);
      if (fetchedHead !== candidate.headSha) {
        fail("factory_revision_mismatch", "Fetched Factory ref does not match the candidate SHA.");
      }

      const expectedContractPath = `.dev_harness/contracts/${candidate.contractId}.json`;
      if (candidate.canonicalContractPath !== expectedContractPath) {
        fail("factory_contract_path_invalid", "Factory contract path does not match its ID.");
      }
      const queuePath = `dev_harness/factory_queue/items/${candidate.queueItemId}.json`;
      const contract = FactoryContractSnapshotSchema.parse(
        parseJson(
          readRegularGitFile(checkout, candidate.headSha, candidate.canonicalContractPath),
          "factory_contract_json_invalid",
        ),
      );
      const queue = FactoryQueueSnapshotSchema.parse(
        parseJson(
          readRegularGitFile(checkout, candidate.headSha, queuePath),
          "factory_queue_json_invalid",
        ),
      );

      if (
        contract.contract_id !== candidate.contractId ||
        contract.canonical_contract_path !== candidate.canonicalContractPath ||
        contract.queue_item_id !== candidate.queueItemId ||
        queue.item_id !== candidate.queueItemId ||
        queue.item.id !== candidate.queueItemId
      ) {
        fail("factory_binding_mismatch", "Factory queue and contract identifiers disagree.");
      }
      const authority = contract.upstream_authority;
      if (
        authority.work_item_id !== intent.workItemId ||
        authority.artifact_id !== intent.id ||
        authority.artifact_version !== 1 ||
        authority.artifact_digest !== intent.specDigest
      ) {
        fail(
          "factory_upstream_authority_mismatch",
          "Factory contract does not match the immutable DevFlow authority.",
        );
      }

      return {
        headSha: candidate.headSha,
        queueItemId: candidate.queueItemId,
        queueItemRevision: queue.revision,
        contractId: candidate.contractId,
        canonicalContractPath: candidate.canonicalContractPath,
        factoryStatus: contract.factory_status,
        status: deriveStatus(
          contract.factory_status,
          contract.surface_signoffs,
          contract.finalizer_admission,
        ),
        surfaces: contract.surfaces,
        impactedSurfaces: contract.impacted_surfaces,
        architectureUnits: contract.architecture_units,
        signoffs: contract.surface_signoffs,
        artifacts: contract.artifacts,
        finalizerReceipt: contract.finalizer_admission,
      };
    },
  };
}
