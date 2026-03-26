import type { IncomingMessage, ServerResponse } from "node:http";
import { runHeartbeatSweep } from "../heartbeat/heartbeat";
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

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleHeartbeat(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  if (triggerSweep.match(req.method, pathSegments)) {
    await triggerSweep.parse(req, res, pathSegments, new URLSearchParams());
    await runHeartbeatSweep();
    json(res, { success: true, message: "Heartbeat sweep completed" });
    return true;
  }

  return false;
}
