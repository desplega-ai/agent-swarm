import type { IncomingMessage, ServerResponse } from "node:http";
import { checkHeartbeatChecklist, runHeartbeatSweep } from "../heartbeat/heartbeat";
import { route } from "./route-def";
import { json } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const triggerSweep = route({
  method: "post",
  path: "/api/heartbeat/sweep",
  pattern: ["api", "heartbeat", "sweep"],
  summary: "Trigger an immediate heartbeat sweep",
  tags: ["Heartbeat"],
  responses: {
    200: { description: "Sweep completed successfully" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

const triggerChecklist = route({
  method: "post",
  path: "/api/heartbeat/checklist",
  pattern: ["api", "heartbeat", "checklist"],
  summary: "Trigger an immediate heartbeat checklist check",
  tags: ["Heartbeat"],
  responses: {
    200: { description: "Checklist check completed successfully" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  if (triggerSweep.match(req.method, pathSegments)) {
    const parsed = await triggerSweep.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    try {
      await runHeartbeatSweep();
      json(res, { success: true, message: "Heartbeat sweep completed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error during heartbeat sweep";
      json(res, { success: false, error: message }, 500);
    }
    return true;
  }

  if (triggerChecklist.match(req.method, pathSegments)) {
    const parsed = await triggerChecklist.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    try {
      await checkHeartbeatChecklist();
      json(res, { success: true, message: "Heartbeat checklist check completed" });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error during heartbeat checklist check";
      json(res, { success: false, error: message }, 500);
    }
    return true;
  }

  return false;
}
