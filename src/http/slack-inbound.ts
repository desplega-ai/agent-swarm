import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getSlackInboundDiagnostics } from "../slack/inbound-dispatch";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Response schemas ────────────────────────────────────────────────────────

const StateCountsSchema = z.object({
  pending: z.number(),
  processing: z.number(),
  processed: z.number(),
  ignored: z.number(),
  failed: z.number(),
  uncertain: z.number(),
});

const FailureSchema = z.object({ code: z.string(), at: z.string() }).nullable();

const OutcomeCountersSchema = z.object({
  processed: z.number(),
  ignored: z.number(),
  failed: z.number(),
  uncertain: z.number(),
  lastOutcomeAt: z.string().nullable(),
  lastFailure: FailureSchema,
});

const SlackInboundDiagnosticsSchema = z.object({
  mode: z.enum(["socket", "http"]).nullable(),
  disabled: z.boolean(),
  receipts: z.object({
    counts: StateCountsSchema,
    backlogBytes: z.number(),
    duplicateDeliveries: z.number(),
    oldestPendingReceivedAt: z.string().nullable(),
    oldestUncertainReceivedAt: z.string().nullable(),
    lastReceivedAt: z.string().nullable(),
    lastFailure: z.object({ errorCode: z.string().nullable(), at: z.string() }).nullable(),
    uncertain: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(["event", "interaction", "command"]),
        payloadType: z.string(),
        eventId: z.string().nullable(),
        errorCode: z.string().nullable(),
        receivedAt: z.string(),
        attempts: z.number(),
      }),
    ),
  }),
  outcomes: z.object({ socket: OutcomeCountersSchema, http: OutcomeCountersSchema }),
  limits: z.object({
    maxBacklogReceipts: z.number(),
    maxBacklogBytes: z.number(),
    maxPayloadBytes: z.number(),
    completedRetentionMs: z.number(),
    maxAttempts: z.number(),
    retryBackoffMs: z.number(),
  }),
});

// ─── Route Definition ────────────────────────────────────────────────────────

const slackInboundDiagnosticsRoute = route({
  method: "get",
  path: "/api/slack/inbound/diagnostics",
  pattern: ["api", "slack", "inbound", "diagnostics"],
  summary:
    "Operator-only. Slack inbound delivery diagnostics: transport mode, durable receipt counts by state, uncertain receipts awaiting review, and per-transport outcome counters. Never includes payloads or credentials.",
  tags: ["Slack"],
  responses: {
    200: { description: "Slack inbound diagnostics", schema: SlackInboundDiagnosticsSchema },
    401: { description: "Unauthorized" },
    403: { description: "Operator access required" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleSlackInbound(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  if (slackInboundDiagnosticsRoute.match(req.method, pathSegments)) {
    const parsed = await slackInboundDiagnosticsRoute.parse(
      req,
      res,
      pathSegments,
      new URLSearchParams(),
    );
    if (!parsed) return true;
    // Receipt ids, Slack event ids and failure codes are operator telemetry.
    // `auth.apiKey` also admits user `aswt_` tokens, and verb-less GETs pass
    // RBAC admission, so gate on the principal kind here.
    if (getRequestAuth(req)?.kind !== "operator") {
      jsonError(res, "Operator access required", 403);
      return true;
    }
    slackInboundDiagnosticsRoute.respond(res, 200, await getSlackInboundDiagnostics());
    return true;
  }
  return false;
}
