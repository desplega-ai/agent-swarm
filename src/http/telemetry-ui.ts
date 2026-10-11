import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { upsertSwarmConfig } from "../be/db";
import { syncTelemetryEnabled } from "../be/telemetry-enable";
import { isTelemetryEnabled, trackRelayed } from "../telemetry";
import { uiEventEmitter, validateUiEvent } from "../telemetry-ui-events";
import { ensureConfigAdmin } from "./config";
import { scheduleIntegrationsReload } from "./core";
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

const enableTelemetry = route({
  method: "post",
  path: "/api/telemetry/enable",
  pattern: ["api", "telemetry", "enable"],
  summary: "Turn telemetry on",
  description:
    "Stores `ANONYMIZED_TELEMETRY=true` and applies it to the running server: the install ID is minted if needed and `telemetry.enabled` is sent once, so no restart is needed.",
  tags: ["Telemetry"],
  body: z.object({ via: z.enum(["banner", "settings"]).default("banner") }),
  responses: {
    200: {
      description: "Telemetry is on",
      schema: z.object({ enabled: z.boolean() }),
    },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
    403: { description: "Only a config admin can turn telemetry on" },
  },
  rbac: { permission: "config.write.any" },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleTelemetryUi(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (enableTelemetry.match(req.method, pathSegments)) {
    const parsed = await enableTelemetry.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureConfigAdmin(req, res, "config.write.any"))) return true;
    await upsertSwarmConfig({ scope: "global", key: "ANONYMIZED_TELEMETRY", value: "true" });
    process.env.ANONYMIZED_TELEMETRY = "true";
    await syncTelemetryEnabled(parsed.body.via);
    scheduleIntegrationsReload();
    enableTelemetry.respond(res, 200, { enabled: isTelemetryEnabled() });
    return true;
  }

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
