import crypto from "node:crypto";
import { getWorkflow, getWorkflowsByScheduleId } from "../be/db";
import type { ScheduledTask, TriggerConfig } from "../types";
import { startWorkflowExecution } from "./engine";
import type { ExecutorRegistry } from "./executors/registry";

/**
 * Handle an incoming webhook trigger for a workflow.
 *
 * 1. Loads the workflow and finds a webhook trigger in `triggers[]`
 * 2. If `hmacSecret` is set, verifies HMAC-SHA256 signature
 * 3. Starts the workflow execution with the webhook payload
 */
export async function handleWebhookTrigger(
  workflowId: string,
  payload: unknown,
  signature: string | undefined,
  signatureHeader: string | undefined,
  registry: ExecutorRegistry,
): Promise<{ runId: string }> {
  const workflow = getWorkflow(workflowId);
  if (!workflow) {
    throw new WebhookError("Workflow not found", 404);
  }

  if (!workflow.enabled) {
    throw new WebhookError("Workflow is disabled", 400);
  }

  // Find webhook trigger in triggers[]
  const webhookTrigger = workflow.triggers.find((t: TriggerConfig) => t.type === "webhook");

  // If the workflow has a webhook trigger with an hmacSecret, verify the signature
  if (webhookTrigger && webhookTrigger.type === "webhook" && webhookTrigger.hmacSecret) {
    if (!signature && !signatureHeader) {
      throw new WebhookError("Missing signature", 401);
    }

    const rawSignature = signatureHeader || signature || "";
    const isValid = verifyHmacSignature(
      webhookTrigger.hmacSecret,
      typeof payload === "string" ? payload : JSON.stringify(payload),
      rawSignature,
    );

    if (!isValid) {
      throw new WebhookError("Invalid signature", 401);
    }
  }

  const runId = await startWorkflowExecution(workflow, payload, registry);
  return { runId };
}

/**
 * Handle a schedule trigger: find workflows linked to this schedule and execute them.
 * Returns an array of workflow run IDs. Empty array means no workflows matched
 * (caller should fall through to standalone task creation).
 */
export async function handleScheduleTrigger(
  scheduleId: string,
  schedule: ScheduledTask,
  registry: ExecutorRegistry,
): Promise<string[]> {
  const workflows = getWorkflowsByScheduleId(scheduleId);
  if (workflows.length === 0) return [];

  const runIds: string[] = [];
  for (const workflow of workflows) {
    const triggerData = {
      scheduleId,
      scheduleName: schedule.name,
      firedAt: new Date().toISOString(),
    };
    const runId = await startWorkflowExecution(workflow, triggerData, registry);
    runIds.push(runId);
    console.log(
      `[Triggers] Schedule "${schedule.name}" triggered workflow "${workflow.name}" (run: ${runId})`,
    );
  }
  return runIds;
}

/**
 * Verify HMAC-SHA256 signature.
 * Supports both `sha256=<hex>` format and raw hex.
 */
export function verifyHmacSignature(
  secret: string,
  body: string,
  providedSignature: string,
): boolean {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  const expectedHex = hmac.digest("hex");

  // Support "sha256=<hex>" format (GitHub-style)
  const normalizedProvided = providedSignature.startsWith("sha256=")
    ? providedSignature.slice(7)
    : providedSignature;

  // Constant-time comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(normalizedProvided, "hex"),
      Buffer.from(expectedHex, "hex"),
    );
  } catch {
    return false;
  }
}

/**
 * Error class for webhook-specific errors with HTTP status codes.
 */
export class WebhookError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "WebhookError";
  }
}
