import type { ZodError, ZodType } from "zod";
import {
  IntakeEvidenceSchema,
  ScopeEvidenceSchema,
  SpecEvidenceSchema,
  type SpecEvidence,
} from "../domain/agent-contracts";
import { DevFlowError } from "../domain/errors";
import { NFR_CATEGORIES, type DevFlowContext } from "../domain/types";
import type { DevFlowRepository } from "../repository";
import type { DevFlowTransitionService } from "./transition-service";

export interface DevFlowEvidenceService {
  applyAgentEvidence(context: DevFlowContext, agentRunId: string, output: unknown): void;
}

function validationMessage(error: ZodError): string {
  const paths = error.issues.map((issue) => issue.path.join(".") || "output");
  return `Agent evidence validation failed at: ${[...new Set(paths)].join(", ")}`;
}

function schemaForMode(mode: "intake" | "scope" | "spec"): ZodType {
  if (mode === "intake") return IntakeEvidenceSchema;
  if (mode === "scope") return ScopeEvidenceSchema;
  return SpecEvidenceSchema;
}

function nfrInputs(output: SpecEvidence) {
  return NFR_CATEGORIES.map((category) => ({
    category,
    status: output.nfrDeclarations[category].status,
    statement: output.nfrDeclarations[category].statement,
  }));
}

export function createEvidenceService(
  repo: DevFlowRepository,
  transitionService: DevFlowTransitionService,
): DevFlowEvidenceService {
  return {
    applyAgentEvidence(context, agentRunId, rawOutput) {
      const run = repo.getAgentRun(context.organizationId, agentRunId);
      if (!run) throw new DevFlowError(404, "not_found", "DevFlow agent run not found.");
      if (run.evidenceAppliedAt) return;
      if (run.status === "succeeded") return;

      const parsed = schemaForMode(run.mode).safeParse(rawOutput);
      if (!parsed.success) {
        const message = validationMessage(parsed.error);
        repo.updateAgentRun(context.organizationId, run.id, {
          status: "failed",
          errorMessage: message,
          finishedAt: new Date().toISOString(),
        });
        repo.appendAuditEvent({
          context,
          workItemId: run.workItemId,
          action: "agent_run.failed",
          metadata: { agentRunId: run.id, mode: run.mode, reason: message },
        });
        throw new DevFlowError(422, "invalid_agent_evidence", message);
      }

      try {
        repo.transaction(() => {
          const item = repo.getWorkItem(context.organizationId, run.workItemId);
          if (!item) throw new DevFlowError(404, "not_found", "DevFlow work item not found.");
          const timestamp = new Date().toISOString();

          if (run.mode === "intake") {
            const output = IntakeEvidenceSchema.parse(parsed.data);
            if (item.state !== "captured") {
              throw new DevFlowError(
                409,
                "agent_evidence_state_mismatch",
                "Intake evidence can only be applied to a captured item.",
              );
            }
            const classification = output.classification === "noise" ? item.type : output.classification;
            repo.updateWorkItem(context.organizationId, item.id, {
              type: classification,
              title: output.title,
              description: output.description,
              priority: output.suggestedPriority ?? undefined,
              duplicateOf: output.duplicateOf ?? undefined,
              duplicateConfidence: output.duplicateConfidence,
              isSecuritySensitive: output.isSecuritySensitiveSignal,
              classificationRationale: output.rationale,
            });
            if (output.classification !== "noise") {
              transitionService.transition(context, item.id, {
                toState: "triaged",
                rationale: output.rationale,
              });
            }
          } else if (run.mode === "scope") {
            const output = ScopeEvidenceSchema.parse(parsed.data);
            if (item.state !== "triaged") {
              throw new DevFlowError(
                409,
                "agent_evidence_state_mismatch",
                "Scope evidence can only be applied to a triaged item.",
              );
            }
            repo.upsertScope(context.organizationId, item.id, { ...output, agentRunId: run.id });
            repo.appendAuditEvent({
              context,
              workItemId: item.id,
              action: "scope.drafted",
              metadata: { agentRunId: run.id, confidence: output.confidence },
            });
          } else {
            const output = SpecEvidenceSchema.parse(parsed.data);
            if (item.state !== "scoped") {
              throw new DevFlowError(
                409,
                "agent_evidence_state_mismatch",
                "Spec evidence can only be applied to a scoped item.",
              );
            }
            const scope = repo.getScope(context.organizationId, item.id);
            const spec = repo.createSpecVersion(context.organizationId, item.id, {
              problemStatement: scope?.problemStatement ?? item.description,
              outOfScope: output.outOfScope,
              uxBehavior: output.uxBehavior,
              dataModelChanges: output.dataModelChanges,
              integrationPoints: output.integrationPoints,
              threatModel: output.threatModel ?? undefined,
              dependencyMap: [],
              openQuestions: output.openQuestions,
              draftedByAgentRunId: run.id,
              acceptanceCriteria: output.acClauses,
              nfrDeclarations: nfrInputs(output),
            });
            repo.updateWorkItem(context.organizationId, item.id, {
              blastRadius: output.blastRadius,
            });
            repo.appendAuditEvent({
              context,
              workItemId: item.id,
              action: "spec.drafted",
              metadata: {
                agentRunId: run.id,
                specId: spec.id,
                specVersion: spec.version,
                confidence: output.confidence,
              },
            });
          }

          repo.updateAgentRun(context.organizationId, run.id, {
            status: "succeeded",
            evidence: parsed.data,
            evidenceAppliedAt: timestamp,
            finishedAt: timestamp,
          });
          repo.appendAuditEvent({
            context,
            workItemId: run.workItemId,
            action: "agent_run.succeeded",
            metadata: { agentRunId: run.id, mode: run.mode },
          });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent evidence application failed";
        repo.updateAgentRun(context.organizationId, run.id, {
          status: "failed",
          errorMessage: message,
          finishedAt: new Date().toISOString(),
        });
        throw error;
      }
    },
  };
}
