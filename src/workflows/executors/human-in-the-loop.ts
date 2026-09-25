import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import { getAppUrl } from "../../utils/constants";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { postApprovalCancellationUpdates } from "../approval-notifications";
import type { ExecutorInput, ExecutorResult } from "./base";
import { BaseExecutor } from "./base";

// ─── Config / Output Schemas ────────────────────────────────

const SelectOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

const QuestionSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("approval"),
    label: z.string(),
    required: z.boolean().default(true),
    description: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("text"),
    label: z.string(),
    required: z.boolean().default(true),
    description: z.string().optional(),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("single-select"),
    label: z.string(),
    required: z.boolean().default(true),
    description: z.string().optional(),
    options: z.array(SelectOptionSchema),
  }),
  z.object({
    id: z.string(),
    type: z.literal("multi-select"),
    label: z.string(),
    required: z.boolean().default(true),
    description: z.string().optional(),
    options: z.array(SelectOptionSchema),
    minSelections: z.number().int().min(0).optional(),
    maxSelections: z.number().int().min(1).optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("boolean"),
    label: z.string(),
    required: z.boolean().default(true),
    description: z.string().optional(),
    defaultValue: z.boolean().optional(),
  }),
]);

const ApproverConfigSchema = z.object({
  users: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  policy: z.union([z.literal("any"), z.literal("all"), z.object({ min: z.number().int().min(1) })]),
});

const NotificationConfigSchema = z.object({
  channel: z.enum(["slack", "email"]),
  target: z.string(),
});

type HITLQuestion = z.infer<typeof QuestionSchema>;

/** Exactly one `{{path}}` token: the dynamic-questions form. */
const DYNAMIC_QUESTIONS_TOKEN_RE = /^\{\{[^}]+\}\}$/;

/**
 * Upper bound on questions per card. Not a render limit (the dashboard lists
 * every question and Slack only shows a truncated summary); a guard against a
 * runaway upstream producing a card nobody can answer. Over the limit the node
 * fails instead of silently dropping items.
 */
export const MAX_HITL_QUESTIONS = 100;

/** Slack Block Kit caps a section block's text at 3000 characters. */
const SLACK_SECTION_TEXT_LIMIT = 3000;

const MAX_REPORTED_ISSUES = 5;

const HITLConfigSchema = z.object({
  title: z.string(),
  // Static array, or one exact `{{token}}` resolved at execute time to an
  // upstream array (see interpolateNodeConfig). `run` validates the resolved
  // value before this schema sees it.
  questions: z.union([
    z.array(QuestionSchema).min(1),
    z
      .string()
      .regex(
        DYNAMIC_QUESTIONS_TOKEN_RE,
        "questions must be an array or one exact {{interpolation}} token",
      ),
  ]),
  approvers: ApproverConfigSchema,
  timeout: z
    .object({
      seconds: z.number().int().min(1),
      action: z.literal("reject"),
    })
    .optional(),
  notifications: z.array(NotificationConfigSchema).optional(),
});

const HITLOutputSchema = z.object({
  requestId: z.string().uuid(),
  status: z.string(),
  responses: z.record(z.string(), z.unknown()).nullable(),
});

type HITLOutput = z.infer<typeof HITLOutputSchema>;

/**
 * Validate the questions a HITL node will put on its card. Static arrays and
 * arrays injected from upstream output (`questions: "{{node.field}}"`) take the
 * same path, so a bad upstream value fails the node with a readable error and
 * never creates a card with zero or malformed questions. Unknown fields are
 * stripped by QuestionSchema; values are stored as display data only.
 */
export function resolveHitlQuestions(
  value: unknown,
): { ok: true; questions: HITLQuestion[] } | { ok: false; error: string } {
  const fail = (reason: string) => ({
    ok: false as const,
    error: `human-in-the-loop questions ${reason}`,
  });

  if (typeof value === "string") {
    return fail(
      value.trim() === ""
        ? "resolved to an empty value: the {{token}} did not resolve (check the node's inputs mapping and the upstream output)"
        : "resolved to a string; they must resolve to an array of question objects (use one exact {{token}} pointing at an array)",
    );
  }
  if (!Array.isArray(value)) {
    return fail(
      `must resolve to an array of question objects, got ${value === null ? "null" : typeof value}`,
    );
  }
  if (value.length === 0) {
    return fail(
      "resolved to an empty array; refusing to create an approval card with no questions",
    );
  }
  if (value.length > MAX_HITL_QUESTIONS) {
    return fail(
      `resolved to ${value.length} questions, over the limit of ${MAX_HITL_QUESTIONS} per card; split or group them upstream`,
    );
  }

  const issues: string[] = [];
  const questions: HITLQuestion[] = [];
  const seenIds = new Set<string>();
  value.forEach((raw, index) => {
    const parsed = QuestionSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length > 0 ? `.${issue.path.map(String).join(".")}` : "";
        issues.push(`[${index}]${path}: ${issue.message}`);
      }
      return;
    }
    const question = parsed.data;
    if (question.id.trim() === "") {
      issues.push(`[${index}].id: must be a non-empty string`);
    } else if (seenIds.has(question.id)) {
      issues.push(`[${index}].id: duplicate id "${question.id}" (responses are keyed by id)`);
    }
    seenIds.add(question.id);
    if (
      (question.type === "single-select" || question.type === "multi-select") &&
      question.options.length === 0
    ) {
      issues.push(`[${index}].options: a ${question.type} question needs at least one option`);
    }
    questions.push(question);
  });

  if (issues.length > 0) {
    const shown = issues.slice(0, MAX_REPORTED_ISSUES).join("; ");
    const more =
      issues.length > MAX_REPORTED_ISSUES
        ? `; and ${issues.length - MAX_REPORTED_ISSUES} more issue(s)`
        : "";
    return fail(`are invalid: ${shown}${more}`);
  }
  return { ok: true, questions };
}

function escapeSlackMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Render the Slack "Questions" section text within Block Kit's 3000-character
 * section limit. Labels are escaped so upstream text cannot inject mentions or
 * links. When the list does not fit, the tail is replaced by a count; every
 * question stays answerable on the dashboard page the card's button opens.
 */
export function buildSlackQuestionsSummary(
  questions: ReadonlyArray<{ label: string }>,
  timeoutText = "",
): string {
  const header = "*Questions:*\n";
  const lines = questions.map((q) => `• ${escapeSlackMrkdwn(q.label.replace(/\s+/g, " ").trim())}`);
  const fits = (shown: string[], omitted: number) => {
    const tail =
      omitted > 0 ? `\n_…and ${omitted} more. Answer all of them on the dashboard._` : "";
    const text = `${header}${shown.join("\n")}${tail}${timeoutText}`;
    return text.length <= SLACK_SECTION_TEXT_LIMIT ? text : null;
  };

  const full = fits(lines, 0);
  if (full) return full;
  for (let count = lines.length - 1; count >= 0; count--) {
    const text = fits(lines.slice(0, count), lines.length - count);
    if (text) return text;
  }
  return `${header}_${questions.length} questions. Answer them on the dashboard._`;
}

// ─── Executor ───────────────────────────────────────────────

export class HumanInTheLoopExecutor extends BaseExecutor<
  typeof HITLConfigSchema,
  typeof HITLOutputSchema
> {
  readonly type = "human-in-the-loop";
  readonly mode = "async" as const;
  readonly configSchema = HITLConfigSchema;
  readonly outputSchema = HITLOutputSchema;

  override async run(input: ExecutorInput): Promise<ExecutorResult<HITLOutput>> {
    const resolved = resolveHitlQuestions(input.config?.questions);
    if (!resolved.ok) return { status: "failed", error: resolved.error };
    return super.run({ ...input, config: { ...input.config, questions: resolved.questions } });
  }

  protected async execute(
    config: z.infer<typeof HITLConfigSchema>,
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<HITLOutput>> {
    const { db } = this.deps;

    // 1. Idempotency: check if an approval request was already created for this step
    const existing = await db.getApprovalRequestByStepId(meta.stepId);
    if (existing) {
      if (existing.status !== "pending") {
        if (existing.status === "cancelled") {
          return {
            status: "failed",
            error: `Approval request was cancelled: ${existing.resolutionReason ?? "workflow run cancelled"}`,
          };
        }
        // Already resolved — return result
        const nextPort =
          existing.status === "timeout"
            ? "timeout"
            : existing.status === "rejected"
              ? "rejected"
              : "approved";
        return {
          status: "success",
          output: {
            requestId: existing.id,
            status: existing.status,
            responses: existing.responses as Record<string, unknown> | null,
          },
          nextPort,
        };
      }
      // Still pending — return async marker
      return {
        status: "success",
        async: true,
        waitFor: "approval.resolved",
        correlationId: existing.id,
      } as unknown as ExecutorResult<HITLOutput>;
    }

    // 2. Create the approval request. `run` already replaced a dynamic token
    // with the validated array; this guards direct execute callers.
    if (!Array.isArray(config.questions)) {
      return { status: "failed", error: "human-in-the-loop questions did not resolve to an array" };
    }
    const requestId = crypto.randomUUID();
    const created = await db.createApprovalRequest({
      id: requestId,
      title: config.title,
      questions: config.questions,
      approvers: config.approvers,
      workflowRunId: meta.runId,
      workflowRunStepId: meta.stepId,
      timeoutSeconds: config.timeout?.seconds,
      notificationChannels: config.notifications,
      createdBy: meta.requestedByUserId,
      requireActionableWorkflow: true,
    });

    if (created.status === "cancelled") {
      return {
        status: "success",
        async: true,
        waitFor: "approval.resolved",
        correlationId: requestId,
      } as unknown as ExecutorResult<HITLOutput>;
    }

    // 3. Dispatch notifications (fire-and-forget — failures must not block the workflow)
    if (config.notifications?.length) {
      this.dispatchNotifications(requestId, config, db).catch((err) => {
        console.error(
          "[HITL] Unexpected error dispatching notifications:",
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        );
      });
    }

    // 4. Return async result — engine will pause the workflow
    return {
      status: "success",
      async: true,
      waitFor: "approval.resolved",
      correlationId: requestId,
    } as unknown as ExecutorResult<HITLOutput>;
  }

  /** Dispatch notifications for each configured channel. Updates DB with messageTs on success. */
  private async dispatchNotifications(
    requestId: string,
    config: z.infer<typeof HITLConfigSchema>,
    db: typeof import("../../be/db"),
  ): Promise<void> {
    if (!config.notifications?.length) return;

    const approvalUrl = `${getAppUrl()}/approval-requests/${requestId}`;
    const updatedChannels = [...config.notifications] as Array<
      z.infer<typeof NotificationConfigSchema> & { messageTs?: string }
    >;
    let updated = false;

    for (let i = 0; i < config.notifications.length; i++) {
      const notification = config.notifications[i]!;

      if (notification.channel === "email") {
        console.warn(
          `[HITL] Email notifications not yet supported (target: ${notification.target})`,
        );
        continue;
      }

      if (notification.channel === "slack") {
        try {
          const { getSlackApp } = await import("../../slack/app");
          const slackApp = getSlackApp();
          if (!slackApp) {
            console.warn("[HITL] Slack not initialized — cannot send notification");
            continue;
          }

          const questions = Array.isArray(config.questions) ? config.questions : [];
          const questionsText = buildSlackQuestionsSummary(questions);

          // The deadline is a caption under the button, not part of the ask.
          const timeoutCaption = config.timeout
            ? [
                {
                  type: "context",
                  elements: [
                    {
                      type: "mrkdwn",
                      text: `⏱ Timeout: ${formatTimeout(config.timeout.seconds)} — auto-rejects if not responded`,
                    },
                  ],
                },
              ]
            : [];

          const blocks = [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `🔔 *Approval Required: ${config.title}*`,
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: questionsText,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Review & Respond" },
                  url: approvalUrl,
                  style: "primary",
                },
              ],
            },
            ...timeoutCaption,
          ];

          const result = await slackApp.client.chat.postMessage({
            channel: notification.target,
            text: `Approval Required: ${config.title} — ${approvalUrl}`,
            unfurl_links: false,
            unfurl_media: false,
            // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
            blocks: blocks as any,
          });

          if (result.ts) {
            updatedChannels[i] = { ...notification, messageTs: result.ts };
            updated = true;
          }

          console.log(
            `[HITL] Slack notification sent to ${notification.target} for request ${requestId}`,
          );
        } catch (err) {
          console.error(
            `[HITL] Failed to send Slack notification to ${notification.target}:`,
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }

    // Persist messageTs values back to DB
    if (updated) {
      try {
        await db.updateApprovalRequestNotifications(requestId, updatedChannels);
        const latest = await db.getApprovalRequestById(requestId);
        if (latest?.status === "cancelled") {
          await postApprovalCancellationUpdates(
            [latest],
            latest.resolutionReason ?? "Workflow run cancelled",
          );
        }
      } catch (err) {
        console.error(
          "[HITL] Failed to update notification channels in DB:",
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }
}

function formatTimeout(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
