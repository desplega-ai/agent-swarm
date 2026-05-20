import crypto from "node:crypto";
import { getWorkflow, getWorkflowsByScheduleId } from "../be/db";
import type { ScheduledTask, TriggerConfig } from "../types";
import { startWorkflowExecution } from "./engine";
import type { ExecutorRegistry } from "./executors/registry";
import { resolveInputValue } from "./input";

/** Header name used to look up an HMAC signature when the trigger configures none. */
const DEFAULT_HMAC_HEADER = "X-Hub-Signature-256";

/** Fallback header names checked (case-insensitive) after the trigger's configured header. */
const FALLBACK_HMAC_HEADERS = ["x-hub-signature-256", "x-signature", "x-webhook-signature"];

/** A bag of HTTP headers — values may be a string, a string array, or absent. */
export type HeaderBag = Record<string, string | string[] | undefined>;

/** Case-insensitive header lookup; returns the first value when an array is given. */
function getHeader(headers: HeaderBag, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * Resolve the HMAC signature from request headers. Checks the trigger's
 * configured `hmacHeader` first, then well-known fallback header names.
 */
function resolveSignature(headers: HeaderBag, hmacHeader: string): string | undefined {
  for (const name of [hmacHeader, ...FALLBACK_HMAC_HEADERS]) {
    const value = getHeader(headers, name);
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve the configured `hmacSecret`. Supports `secret.NAME` swarm-secret refs
 * and `${ENV_VAR}` env refs (reusing the workflow input resolver); a plain
 * string is treated as a literal. Resolved per request, never at create time.
 */
function resolveHmacSecret(raw: string): string {
  if (/^secret\..+$/.test(raw) || /^\$\{.+\}$/.test(raw)) {
    try {
      return resolveInputValue(raw);
    } catch (err) {
      throw new WebhookError(
        `Failed to resolve webhook HMAC secret: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
  }
  return raw;
}

/**
 * Handle an incoming webhook trigger for a workflow.
 *
 * 1. Loads the workflow and finds a webhook trigger in `triggers[]`
 * 2. If `hmacSecret` is set, resolves the signature header + secret and
 *    verifies the HMAC-SHA256 signature against the raw body bytes
 * 3. Parses the raw body as JSON (falling back to the raw string when the
 *    body is non-JSON) so downstream `{{trigger.deep.path}}` interpolation
 *    can traverse the object — matches the shape produced by the
 *    `trigger-workflow` MCP tool.
 * 4. Starts the workflow execution with the parsed payload
 */
export async function handleWebhookTrigger(
  workflowId: string,
  payload: unknown,
  headers: HeaderBag,
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
  // against the RAW body bytes — re-serializing would change whitespace / key order
  // and break the HMAC.
  if (webhookTrigger && webhookTrigger.type === "webhook" && webhookTrigger.hmacSecret) {
    const hmacHeader = webhookTrigger.hmacHeader || DEFAULT_HMAC_HEADER;
    const signature = resolveSignature(headers, hmacHeader);
    if (!signature) {
      throw new WebhookError("Missing signature", 401);
    }

    const secret = resolveHmacSecret(webhookTrigger.hmacSecret);
    const isValid = verifyHmacSignature(
      secret,
      typeof payload === "string" ? payload : JSON.stringify(payload),
      signature,
    );

    if (!isValid) {
      throw new WebhookError("Invalid signature", 401);
    }
  }

  // Parse the raw body so downstream nodes can interpolate deep paths
  // (e.g. `{{trigger.message.from}}`). A non-JSON body falls back to the raw
  // string so non-JSON webhooks don't break.
  const triggerData = parseTriggerPayload(payload);

  const runId = await startWorkflowExecution(workflow, triggerData, registry);
  return { runId };
}

/**
 * If `payload` is a JSON string, parse and return the resulting value;
 * otherwise return it as-is. Empty / non-JSON strings fall back to the raw
 * value so non-JSON webhooks (text/plain, form-encoded, etc.) still produce
 * a usable workflow run.
 */
function parseTriggerPayload(payload: unknown): unknown {
  if (typeof payload !== "string" || payload.length === 0) return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
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
