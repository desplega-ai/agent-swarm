import type { DevFlowRepository } from "../../devflow/repository";
import type { AriaClientIntake, AriaSlackSurface } from "../domain/types";
import type { AriaHqRepository } from "../repository";

const SECURITY_PATTERN =
  /\b(api[- ]?key|credential|exploit|security|secret|token|vulnerab(?:ility|le)|data breach|exposed)\b/i;
const BUG_PATTERN = /\b(bug|broken|crash|error|fail(?:s|ed|ure)?|not working|blank)\b/i;

export interface CaptureClientIntakeInput {
  surface: AriaSlackSurface;
  messageTs: string;
  threadTs?: string;
  externalUserId: string;
  text: string;
}

export interface CapturedClientIntake {
  intake: AriaClientIntake;
  securitySensitive: boolean;
  duplicate: boolean;
}

export interface ClientIntakeService {
  capture(input: CaptureClientIntakeInput): CapturedClientIntake;
}

function cleanMessage(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFor(text: string): string {
  const clean = cleanMessage(text);
  if (clean.length <= 120) return clean;
  return `${clean.slice(0, 117).trimEnd()}...`;
}

export function createClientIntakeService(input: {
  aria: AriaHqRepository;
  devflow: DevFlowRepository;
}): ClientIntakeService {
  return {
    capture(captureInput) {
      const { surface } = captureInput;
      if (surface.audience !== "client" || !surface.clientKey) {
        throw new Error("Only a configured client Slack surface can create a client intake");
      }
      const existing = input.aria.getClientIntakeByMessage(surface.id, captureInput.messageTs);
      if (existing) {
        const item = input.devflow.getWorkItem(surface.organizationId, existing.workItemId);
        return {
          intake: existing,
          securitySensitive: item?.isSecuritySensitive ?? false,
          duplicate: true,
        };
      }

      const content = cleanMessage(captureInput.text);
      const securitySensitive = SECURITY_PATTERN.test(content);
      return input.aria.transaction(() => {
        const raced = input.aria.getClientIntakeByMessage(surface.id, captureInput.messageTs);
        if (raced) {
          const item = input.devflow.getWorkItem(surface.organizationId, raced.workItemId);
          return {
            intake: raced,
            securitySensitive: item?.isSecuritySensitive ?? false,
            duplicate: true,
          };
        }
        const workItem = input.devflow.createWorkItem({
          organizationId: surface.organizationId,
          type: BUG_PATTERN.test(content) ? "bug" : "idea",
          title: titleFor(content),
          description: content,
          pmOwnerId: surface.pmOwnerId,
          createdVia: "slack",
          sourceMetadata: {
            clientKey: surface.clientKey,
            workspaceId: surface.workspaceId,
            channelId: surface.channelId,
            messageTs: captureInput.messageTs,
            threadTs: captureInput.threadTs ?? captureInput.messageTs,
            externalUserId: captureInput.externalUserId,
          },
        });
        if (securitySensitive) {
          input.devflow.updateWorkItem(surface.organizationId, workItem.id, {
            isSecuritySensitive: true,
            priority: "p1",
          });
        }
        input.aria.ingestKnowledge({
          organizationId: surface.organizationId,
          kind: "source_evidence",
          sourceKind: "slack",
          sourceRef: `slack:${surface.workspaceId}:${surface.channelId}:${captureInput.messageTs}`,
          sourceRevision: captureInput.messageTs,
          audience: "client",
          clientKey: surface.clientKey,
          title: titleFor(content),
          content,
          verificationStatus: "raw",
          effectiveAt: new Date(Number.parseFloat(captureInput.messageTs) * 1000).toISOString(),
          metadata: {
            workItemId: workItem.id,
            externalUserId: captureInput.externalUserId,
            securitySensitive,
          },
        });
        const intake = input.aria.createClientIntake({
          organizationId: surface.organizationId,
          slackSurfaceId: surface.id,
          workItemId: workItem.id,
          messageTs: captureInput.messageTs,
          threadTs: captureInput.threadTs ?? captureInput.messageTs,
          externalUserId: captureInput.externalUserId,
          clientStatus: "captured",
          publicSummary: securitySensitive
            ? "Security-sensitive report received for protected review."
            : content,
        });
        input.devflow.appendAuditEvent({
          context: {
            organizationId: surface.organizationId,
            actorKind: "system",
            actorId: "ariahq-slack",
            correlationId: `slack:${surface.channelId}:${captureInput.messageTs}`,
          },
          workItemId: workItem.id,
          action: "ariahq.client_intake.captured",
          afterState: "captured",
          metadata: {
            clientKey: surface.clientKey,
            slackSurfaceId: surface.id,
            externalUserId: captureInput.externalUserId,
            securitySensitive,
          },
        });
        return { intake, securitySensitive, duplicate: false };
      });
    },
  };
}
