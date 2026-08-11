import { DevFlowError } from "../domain/errors";
import type { DevFlowContext, DevFlowImplementationIntent, DevFlowPriority } from "../domain/types";
import type { DevFlowRepository } from "../repository";

export interface CreateImplementationIntentRequest {
  repositoryTargetId: string;
  desiredOutcome: string;
  riskSummary: string;
  priority?: DevFlowPriority;
}

export interface DevFlowImplementationIntentService {
  create(
    context: DevFlowContext,
    workItemId: string,
    request: CreateImplementationIntentRequest,
  ): DevFlowImplementationIntent;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return `sha256:${hasher.digest("hex")}`;
}

export function createImplementationIntentService(
  repo: DevFlowRepository,
): DevFlowImplementationIntentService {
  return {
    create(context, workItemId, request) {
      const item = repo.getWorkItem(context.organizationId, workItemId);
      if (!item) throw new DevFlowError(404, "not_found", "DevFlow work item not found.");
      const membership =
        context.actorKind === "user" && context.actorId
          ? repo.getMembership(context.organizationId, context.actorId)
          : null;
      if (
        context.actorKind !== "user" ||
        !context.actorId ||
        !membership ||
        !["admin", "pm_director", "pm"].includes(membership.role)
      ) {
        throw new DevFlowError(
          403,
          "implementation_intent_forbidden",
          "A DevFlow product authority role is required.",
        );
      }
      const target = repo.getRepositoryTarget(context.organizationId, request.repositoryTargetId);
      if (!target || !target.isActive) {
        throw new DevFlowError(
          404,
          "repository_target_not_found",
          "Active repository target not found.",
        );
      }
      const scope = repo.getScope(context.organizationId, workItemId);
      const spec = repo.getCurrentSpec(context.organizationId, workItemId);
      const gate2 = repo
        .listGateDecisions(context.organizationId, workItemId)
        .find((decision) => decision.gate === 2 && decision.decision === "approved");
      if (
        item.state !== "specced" ||
        !scope?.pmSignedOffAt ||
        spec?.status !== "approved" ||
        !spec.approvedAt ||
        !gate2
      ) {
        throw new DevFlowError(
          409,
          "implementation_intent_not_ready",
          "An approved Gate 2 spec is required before Factory intake.",
        );
      }

      const snapshot = {
        schemaVersion: 1,
        workItem: item,
        scope,
        spec,
        gate2,
        repositoryTarget: {
          id: target.id,
          name: target.name,
          repositoryFullName: target.repositoryFullName,
          defaultBranch: target.defaultBranch,
          executionProfile: target.executionProfile,
        },
        desiredOutcome: request.desiredOutcome,
        riskSummary: request.riskSummary,
      };
      const digest = sha256(canonicalStringify(snapshot));
      const existing = repo
        .listImplementationIntents(context.organizationId, workItemId)
        .find(
          (intent) =>
            intent.specId === spec.id &&
            intent.repositoryTargetId === target.id &&
            intent.specDigest === digest,
        );
      if (existing) return existing;

      return repo.transaction(() => {
        const intent = repo.createImplementationIntent({
          organizationId: context.organizationId,
          workItemId,
          specId: spec.id,
          specVersion: spec.version,
          specDigest: digest,
          repositoryTargetId: target.id,
          desiredOutcome: request.desiredOutcome,
          priority: request.priority ?? item.priority ?? "p3",
          riskSummary: request.riskSummary,
          intentSnapshot: snapshot,
          createdByUserId: context.actorId!,
        });
        repo.appendAuditEvent({
          context,
          workItemId,
          action: "implementation_intent.created",
          metadata: {
            implementationIntentId: intent.id,
            repositoryTargetId: target.id,
            specId: spec.id,
            specVersion: spec.version,
            specDigest: digest,
          },
        });
        return intent;
      });
    },
  };
}
