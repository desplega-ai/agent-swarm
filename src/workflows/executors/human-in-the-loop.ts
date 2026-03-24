import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import type { ExecutorResult } from "./base";
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

const HITLConfigSchema = z.object({
  title: z.string(),
  questions: z.array(QuestionSchema).min(1),
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

// ─── Executor ───────────────────────────────────────────────

export class HumanInTheLoopExecutor extends BaseExecutor<
  typeof HITLConfigSchema,
  typeof HITLOutputSchema
> {
  readonly type = "human-in-the-loop";
  readonly mode = "async" as const;
  readonly configSchema = HITLConfigSchema;
  readonly outputSchema = HITLOutputSchema;

  protected async execute(
    config: z.infer<typeof HITLConfigSchema>,
    _context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<HITLOutput>> {
    const { db } = this.deps;

    // 1. Idempotency: check if an approval request was already created for this step
    const existing = db.getApprovalRequestByStepId(meta.stepId);
    if (existing) {
      if (existing.status !== "pending") {
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

    // 2. Create the approval request
    const requestId = crypto.randomUUID();
    db.createApprovalRequest({
      id: requestId,
      title: config.title,
      questions: config.questions,
      approvers: config.approvers,
      workflowRunId: meta.runId,
      workflowRunStepId: meta.stepId,
      timeoutSeconds: config.timeout?.seconds,
      notificationChannels: config.notifications,
    });

    // 3. Return async result — engine will pause the workflow
    return {
      status: "success",
      async: true,
      waitFor: "approval.resolved",
      correlationId: requestId,
    } as unknown as ExecutorResult<HITLOutput>;
  }
}
