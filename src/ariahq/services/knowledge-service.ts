import { type CreateTaskOptions, createTaskExtended } from "../../be/db";
import type { AgentTask } from "../../types";
import type { AriaHqContext, AriaKnowledgeRecord } from "../domain/types";
import { buildKnowledgeAnswerPrompt } from "../prompts";
import type { AriaHqRepository } from "../repository";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "how",
  "is",
  "of",
  "on",
  "the",
  "to",
  "what",
  "when",
  "where",
  "who",
  "why",
]);

export interface EvidenceItem {
  recordId: string;
  kind: AriaKnowledgeRecord["kind"];
  content: string;
  verificationStatus: AriaKnowledgeRecord["verificationStatus"];
  effectiveAt: string;
  citation: string;
}

export interface EvidenceBundle {
  question: string;
  audience: AriaHqContext["audience"];
  clientKey?: string;
  evidence: EvidenceItem[];
  hasConflict: boolean;
}

export interface KnowledgeAnswerTaskRuntime {
  create(prompt: string, options: CreateTaskOptions): AgentTask;
}

export type KnowledgeAnswerResult = {
  status: "dispatched" | "abstained";
  bundle: EvidenceBundle;
  taskId?: string;
  message?: string;
};

export type KnowledgeAnswerOptions = {
  now?: string;
  limit?: number;
  slackChannelId?: string;
  slackThreadTs?: string;
  slackTriggerMessageTs?: string;
  slackUserId?: string;
};

export interface KnowledgeService {
  buildEvidenceBundle(
    context: AriaHqContext,
    question: string,
    options?: Pick<KnowledgeAnswerOptions, "now" | "limit">,
  ): EvidenceBundle;
  startAnswer(
    context: AriaHqContext,
    question: string,
    options?: KnowledgeAnswerOptions,
  ): KnowledgeAnswerResult;
}

function retrievalQuery(question: string): string {
  const tokens = question
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
  return [...new Set(tokens)].join(" ");
}

function renderCitation(record: AriaKnowledgeRecord): string {
  const location = record.sourceUrl ? ` ${record.sourceUrl}` : "";
  return `[${record.id}] ${record.sourceKind}:${record.sourceRef}${location} effective=${record.effectiveAt} verification=${record.verificationStatus}`;
}

function answerOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["answer", "citations", "confidence", "hasConflict"],
    properties: {
      answer: { type: "string" },
      citations: { type: "array", items: { type: "string" } },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      hasConflict: { type: "boolean" },
    },
  };
}

export function createKnowledgeService(input: {
  repo: AriaHqRepository;
  taskRuntime?: KnowledgeAnswerTaskRuntime;
}): KnowledgeService {
  const taskRuntime = input.taskRuntime ?? { create: createTaskExtended };

  return {
    buildEvidenceBundle(context, question, options = {}) {
      if (!question.trim()) throw new Error("Knowledge question is required");
      if (context.audience === "client" && !context.clientKey) {
        return { question, audience: "client", evidence: [], hasConflict: false };
      }
      const query = retrievalQuery(question);
      if (!query) {
        return {
          question,
          audience: context.audience,
          ...(context.clientKey ? { clientKey: context.clientKey } : {}),
          evidence: [],
          hasConflict: false,
        };
      }
      const evidence = input.repo
        .searchKnowledge({
          organizationId: context.organizationId,
          query,
          audience: context.audience,
          ...(context.clientKey ? { clientKey: context.clientKey } : {}),
          ...(options.now ? { now: options.now } : {}),
          limit: options.limit ?? 12,
        })
        .map(({ record }) => ({
          recordId: record.id,
          kind: record.kind,
          content: record.content,
          verificationStatus: record.verificationStatus,
          effectiveAt: record.effectiveAt,
          citation: renderCitation(record),
        }));
      return {
        question,
        audience: context.audience,
        ...(context.clientKey ? { clientKey: context.clientKey } : {}),
        evidence,
        hasConflict: evidence.some((item) => item.verificationStatus === "conflicted"),
      };
    },

    startAnswer(context, question, options = {}) {
      const bundle = this.buildEvidenceBundle(context, question, options);
      if (bundle.evidence.length === 0) {
        return {
          status: "abstained",
          bundle,
          message:
            "I do not have sufficient authorized evidence to answer that definitively. I can help identify the missing source.",
        };
      }
      const task = taskRuntime.create(
        buildKnowledgeAnswerPrompt({
          question,
          evidenceJson: JSON.stringify(bundle.evidence),
          hasConflict: bundle.hasConflict,
        }),
        {
          source: "api",
          taskType: "ariahq-knowledge-answer",
          tags: [
            "ariahq",
            "organizational-brain",
            `organization:${context.organizationId}`,
            `audience:${context.audience}`,
          ],
          priority: 2,
          status: "unassigned",
          outputSchema: answerOutputSchema(),
          ...(context.actorKind === "user" && context.actorId
            ? { requestedByUserId: context.actorId }
            : {}),
          ...(options.slackChannelId ? { slackChannelId: options.slackChannelId } : {}),
          ...(options.slackThreadTs ? { slackThreadTs: options.slackThreadTs } : {}),
          ...(options.slackTriggerMessageTs
            ? { slackTriggerMessageTs: options.slackTriggerMessageTs }
            : {}),
          ...(options.slackUserId ? { slackUserId: options.slackUserId } : {}),
          contextKey: `ariahq:knowledge-answer:${crypto.randomUUID()}`,
        },
      );
      return { status: "dispatched", bundle, taskId: task.id };
    },
  };
}
