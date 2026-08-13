import type { DevFlowRepository } from "../devflow/repository";
import type { AriaClientIntake } from "./domain/types";
import type { AriaHqRepository } from "./repository";
import type { ClientIntakeService } from "./services/client-intake";
import type { KnowledgeService } from "./services/knowledge-service";

export interface AriaSlackIngressInput {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  externalUserId: string;
  text: string;
  botUserId: string;
}

export type AriaSlackIngressResult = {
  recognized: boolean;
  handled: boolean;
  intake?: AriaClientIntake;
  reply?: string;
};

export function handleAriaSlackIngress(
  dependencies: { aria: AriaHqRepository; intake: ClientIntakeService },
  input: AriaSlackIngressInput,
): AriaSlackIngressResult {
  const surface = dependencies.aria.findSlackSurface(input.workspaceId, input.channelId);
  if (!surface || surface.audience !== "client") {
    return { recognized: false, handled: false };
  }
  const mentioned = input.text.includes(`<@${input.botUserId}>`);
  if (surface.captureMode === "mention_only" && !mentioned) {
    return { recognized: true, handled: false };
  }
  const captured = dependencies.intake.capture({
    surface,
    messageTs: input.messageTs,
    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    externalUserId: input.externalUserId,
    text: input.text,
  });
  const caseId = `DF-${captured.intake.workItemId.slice(0, 8).toUpperCase()}`;
  return {
    recognized: true,
    handled: true,
    intake: captured.intake,
    reply: captured.securitySensitive
      ? `Captured as ${caseId}. Aria has routed this to protected review; sensitive details will not be repeated in this channel.`
      : `Captured as ${caseId}. Aria has linked this thread and the DevFlow team is reviewing it.`,
  };
}

export function handleAriaInternalSlackQuestion(
  dependencies: {
    aria: AriaHqRepository;
    devflow: DevFlowRepository;
    knowledge: KnowledgeService;
  },
  input: AriaSlackIngressInput & { requestedByUserId?: string },
): AriaSlackIngressResult & { taskId?: string } {
  const surface = dependencies.aria.findSlackSurface(input.workspaceId, input.channelId);
  if (!surface || surface.audience !== "internal") return { recognized: false, handled: false };
  if (!input.text.includes(`<@${input.botUserId}>`)) return { recognized: false, handled: false };
  if (
    !input.requestedByUserId ||
    !dependencies.devflow.getMembership(surface.organizationId, input.requestedByUserId)
  ) {
    return {
      recognized: true,
      handled: true,
      reply:
        "I can't access organizational knowledge until your Slack identity is linked to this AriaHQ organization.",
    };
  }
  const question = input.text.replaceAll(`<@${input.botUserId}>`, "").trim();
  if (!question) {
    return { recognized: true, handled: true, reply: "What would you like to know?" };
  }
  const answer = dependencies.knowledge.startAnswer(
    {
      organizationId: surface.organizationId,
      actorKind: "user",
      actorId: input.requestedByUserId,
      audience: "internal",
    },
    question,
    {
      slackChannelId: input.channelId,
      slackThreadTs: input.threadTs ?? input.messageTs,
      slackTriggerMessageTs: input.messageTs,
      slackUserId: input.externalUserId,
    },
  );
  if (answer.status === "abstained") {
    return { recognized: true, handled: true, reply: answer.message };
  }
  return {
    recognized: true,
    handled: true,
    taskId: answer.taskId,
    reply: "I found authorized evidence and am preparing a sourced answer in this thread.",
  };
}
