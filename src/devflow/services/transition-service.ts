import { DevFlowError } from "../domain/errors";
import { DISABLED_FORWARD_TRANSITIONS, isSliceOneTransition } from "../domain/transitions";
import {
  type DevFlowContext,
  type DevFlowRole,
  type DevFlowState,
  NFR_CATEGORIES,
} from "../domain/types";
import type { DevFlowRepository } from "../repository";

export interface TransitionRequest {
  toState: DevFlowState;
  rationale: string;
  blockerReason?: string;
  archiveReason?: string;
  approvalRequestId?: string;
}

export interface TransitionResult {
  workItemId: string;
  fromState: DevFlowState;
  toState: DevFlowState;
  transitionedAt: string;
  auditEventId: string;
}

export interface DevFlowTransitionService {
  transition(
    context: DevFlowContext,
    workItemId: string,
    request: TransitionRequest,
  ): TransitionResult;
}

function assertRole(role: DevFlowRole, allowed: readonly DevFlowRole[], message: string): void {
  if (!allowed.includes(role)) {
    throw new DevFlowError(403, "insufficient_permission", message, {
      actor_role: role,
      allowed_roles: allowed,
    });
  }
}

export function createTransitionService(repo: DevFlowRepository): DevFlowTransitionService {
  return {
    transition(context, workItemId, request) {
      if (!request.rationale.trim()) {
        throw new DevFlowError(422, "rationale_required", "A transition rationale is required.");
      }

      return repo.transaction(() => {
        const item = repo.getWorkItem(context.organizationId, workItemId);
        if (!item) {
          throw new DevFlowError(404, "not_found", "DevFlow work item not found.");
        }

        const membership =
          context.actorKind === "user" && context.actorId
            ? repo.getMembership(context.organizationId, context.actorId)
            : null;
        if (context.actorKind === "user" && !membership) {
          throw new DevFlowError(
            403,
            "insufficient_permission",
            "An active organization membership is required.",
          );
        }

        const fromState = item.state;
        const isBlockedRestore =
          fromState === "blocked" &&
          item.previousState === request.toState &&
          request.toState !== "blocked";
        const isEnabled = isSliceOneTransition(fromState, request.toState) || isBlockedRestore;
        if (!isEnabled) {
          const edge = `${fromState}:${request.toState}`;
          if (DISABLED_FORWARD_TRANSITIONS.has(edge)) {
            throw new DevFlowError(
              409,
              "transition_not_enabled",
              `The ${fromState} to ${request.toState} transition is not enabled in this delivery slice.`,
              { current_state: fromState, attempted_state: request.toState },
            );
          }
          throw new DevFlowError(
            409,
            "invalid_state_transition",
            `Cannot transition from ${fromState} to ${request.toState}.`,
            { current_state: fromState, attempted_state: request.toState },
          );
        }

        if (request.toState === "triaged") {
          if (context.actorKind !== "agent" && context.actorKind !== "system") {
            throw new DevFlowError(
              403,
              "insufficient_permission",
              "Captured items are triaged by an agent or system action.",
            );
          }
          if (!item.classificationRationale?.trim()) {
            throw new DevFlowError(
              422,
              "preconditions_not_met",
              "Intake classification rationale is required before triage.",
              { missing_fields: ["classificationRationale"] },
            );
          }
        }

        const timestamp = new Date().toISOString();
        let gate: 1 | 2 | undefined;
        let preconditionSnapshot: Record<string, unknown> = {};

        if (fromState === "triaged" && request.toState === "scoped") {
          if (!membership || !context.actorId) {
            throw new DevFlowError(403, "insufficient_permission", "Gate 1 requires a PM role.");
          }
          assertRole(membership.role, ["pm", "pm_director", "admin"], "Gate 1 requires a PM role.");
          const scope = repo.getScope(context.organizationId, workItemId);
          if (!scope) {
            throw new DevFlowError(422, "preconditions_not_met", "Gate 1 scope is incomplete.", {
              missing_fields: ["scope"],
            });
          }
          const missingFields: string[] = [];
          if (!scope.problemStatement.trim()) missingFields.push("problemStatement");
          if (!scope.targetUsers.length) missingFields.push("targetUsers");
          if (!scope.successCriteria.length) missingFields.push("successCriteria");
          if (!scope.effortBand) missingFields.push("effortBand");
          if (missingFields.length > 0) {
            throw new DevFlowError(422, "preconditions_not_met", "Gate 1 scope is incomplete.", {
              missing_fields: missingFields,
            });
          }
          gate = 1;
          preconditionSnapshot = { scopeId: scope.id, confidence: scope.confidence };
          repo.signOffScope(context.organizationId, workItemId, timestamp);
        }

        if (fromState === "scoped" && request.toState === "specced") {
          if (!membership || !context.actorId) {
            throw new DevFlowError(
              403,
              "insufficient_permission",
              "Gate 2 requires an engineering lead role.",
            );
          }
          assertRole(
            membership.role,
            ["engineering_lead", "admin"],
            "Gate 2 requires an engineering lead role.",
          );
          const spec = repo.getCurrentSpec(context.organizationId, workItemId);
          const missingFields: string[] = [];
          const untestableIds: string[] = [];
          const pendingNfrs: string[] = [];
          if (!spec) {
            missingFields.push("spec");
          } else {
            if (!spec.acceptanceCriteria.length) missingFields.push("acceptanceCriteria");
            untestableIds.push(
              ...spec.acceptanceCriteria
                .filter((criterion) => !criterion.isTestable)
                .map((c) => c.id),
            );
            const byCategory = new Map(spec.nfrDeclarations.map((nfr) => [nfr.category, nfr]));
            for (const category of NFR_CATEGORIES) {
              const nfr = byCategory.get(category);
              if (!nfr || nfr.status === "pending" || !nfr.statement.trim())
                pendingNfrs.push(category);
            }
            if (!spec.uxBehavior.trim()) missingFields.push("uxBehavior");
            if (!spec.dataModelChanges.trim()) missingFields.push("dataModelChanges");
            if (!spec.integrationPoints.trim()) missingFields.push("integrationPoints");
            if (item.isSecuritySensitive && !spec.threatModel?.trim())
              missingFields.push("threatModel");
          }
          if (!item.blastRadius) missingFields.push("blastRadius");
          if (missingFields.length || untestableIds.length || pendingNfrs.length) {
            const phrases: string[] = [];
            if (untestableIds.length) phrases.push("all acceptance criteria must be testable");
            if (pendingNfrs.length) phrases.push("all NFR declarations must be resolved");
            if (missingFields.includes("threatModel")) phrases.push("a threat model is required");
            if (missingFields.length && phrases.length === 0)
              phrases.push("required spec fields are missing");
            throw new DevFlowError(
              422,
              "preconditions_not_met",
              `Gate 2 cannot be approved: ${phrases.join("; ")}.`,
              {
                missing_fields: missingFields,
                untestable_acceptance_criteria_ids: untestableIds,
                pending_nfrs: pendingNfrs,
              },
            );
          }
          gate = 2;
          preconditionSnapshot = {
            specId: spec!.id,
            specVersion: spec!.version,
            acceptanceCriteriaCount: spec!.acceptanceCriteria.length,
            blastRadius: item.blastRadius,
          };
          repo.approveCurrentSpec(context.organizationId, workItemId, timestamp);
        }

        if (request.toState === "blocked") {
          if (!membership) {
            throw new DevFlowError(403, "insufficient_permission", "Blocking requires a user.");
          }
          if (!request.blockerReason?.trim()) {
            throw new DevFlowError(422, "preconditions_not_met", "A blocker reason is required.", {
              missing_fields: ["blockerReason"],
            });
          }
        }

        if (isBlockedRestore) {
          if (!membership || !context.actorId) {
            throw new DevFlowError(
              403,
              "insufficient_permission",
              "Resolving a blocker requires a user.",
            );
          }
          const blockedEvent = repo
            .listAuditEvents(context.organizationId, workItemId)
            .find((event) => event.action === "work_item.blocked");
          const isOriginalBlocker = blockedEvent?.actorId === context.actorId;
          const isLead = ["engineering_lead", "admin"].includes(membership.role);
          if (!isOriginalBlocker && !isLead) {
            throw new DevFlowError(
              403,
              "insufficient_permission",
              "Only the blocker author or an engineering lead can resolve this blocker.",
            );
          }
        }

        if (request.toState === "archived") {
          if (!membership) {
            throw new DevFlowError(403, "insufficient_permission", "Archiving requires a user.");
          }
          assertRole(
            membership.role,
            ["admin", "pm_director"],
            "Archiving requires an admin or PM director role.",
          );
          if (!request.archiveReason?.trim()) {
            throw new DevFlowError(422, "preconditions_not_met", "An archive reason is required.", {
              missing_fields: ["archiveReason"],
            });
          }
        }

        if (gate && membership && context.actorId) {
          repo.createGateDecision({
            organizationId: context.organizationId,
            workItemId,
            gate,
            decision: "approved",
            actorUserId: context.actorId,
            actorRole: membership.role,
            rationale: request.rationale,
            preconditionSnapshot,
            approvalRequestId: request.approvalRequestId,
          });
        }

        repo.updateWorkItem(context.organizationId, workItemId, {
          state: request.toState,
          previousState:
            request.toState === "blocked"
              ? fromState
              : isBlockedRestore
                ? undefined
                : item.previousState,
          blockerReason:
            request.toState === "blocked"
              ? request.blockerReason
              : isBlockedRestore
                ? undefined
                : item.blockerReason,
          archiveReason:
            request.toState === "archived" ? request.archiveReason : item.archiveReason,
        });
        const action =
          request.toState === "blocked"
            ? "work_item.blocked"
            : isBlockedRestore
              ? "work_item.unblocked"
              : `work_item.${request.toState}`;
        const audit = repo.appendAuditEvent({
          context,
          workItemId,
          action,
          beforeState: fromState,
          afterState: request.toState,
          metadata: { rationale: request.rationale, gate },
        });
        return {
          workItemId,
          fromState,
          toState: request.toState,
          transitionedAt: timestamp,
          auditEventId: audit.id,
        };
      });
    },
  };
}
