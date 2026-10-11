import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { isTelemetryEnabled, trackRelayed } from "../telemetry";
import { uiEventEmitter, validateUiEvent } from "../telemetry-ui-events";
import { resolveHttpFavoriteOwner } from "./favorite-owner";
import { rejectGuest } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const uiEvent = route({
  method: "post",
  path: "/api/telemetry/ui-event",
  pattern: ["api", "telemetry", "ui-event"],
  summary: "Send a dashboard telemetry event",
  description:
    "Relays one catalogued dashboard event (`popup.*`, `notification.*`, ...) through the API's telemetry client, so it carries the normal v2 envelope. Answers 204 without sending anything when telemetry is off.",
  tags: ["Telemetry"],
  body: z.object({
    event: z.string().min(1).max(64),
    properties: z.record(z.string(), z.unknown()).default({}),
  }),
  maxBodyBytes: 8 * 1024,
  responses: {
    204: { description: "Accepted, or dropped because telemetry is off" },
    400: { description: "Unknown event or invalid properties" },
    401: { description: "Unauthorized" },
    403: { description: "Guest page sessions cannot send events" },
  },
  rbac: { ungated: "any authenticated dashboard user; event name allowlisted" },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleTelemetryUi(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (!uiEvent.match(req.method, pathSegments)) return false;
  if (rejectGuest(req, res)) return true;
  const parsed = await uiEvent.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;

  const { event, properties } = parsed.body;
  const problems = validateUiEvent(event, properties);
  if (problems.length > 0) {
    jsonError(res, `Invalid telemetry event: ${problems.join("; ")}`, 400);
    return true;
  }

  if (isTelemetryEnabled()) {
    const owner = await resolveHttpFavoriteOwner(req, myAgentId);
    trackRelayed(event, properties, {
      actor: owner?.userId ? { userId: owner.userId } : undefined,
      emitter: uiEventEmitter(event) ?? "ui",
    });
  }
  res.writeHead(204);
  res.end();
  return true;
}
