import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getWorkflowRun } from "../be/db";
import { workflowEventBus } from "../workflows/event-bus";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

/**
 * Run-scoped event signal: emits `name` on `workflowEventBus` with the payload
 * augmented by `_runId` (so wait-states with `scope: 'run'` can correlate).
 *
 * Existing built-in bus events from `src/be/db.ts` carry `workflowRunId`; the
 * matcher in `src/workflows/resume.ts` accepts either field name.
 */
const runScopedSignalRoute = route({
  method: "post",
  path: "/api/workflow-runs/{runId}/events",
  pattern: ["api", "workflow-runs", null, "events"],
  summary: "Fire a run-scoped event signal",
  description:
    "Emits an event onto the workflow event bus with `_runId` injected. " +
    "Used by wait nodes in `event` mode with `scope: 'run'`. The body's `name` " +
    "is the bus event name; `payload` is forwarded as-is plus `_runId`.",
  tags: ["WorkflowEvents"],
  params: z.object({ runId: z.string().uuid() }),
  body: z.object({
    name: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  responses: {
    200: { description: "Event emitted" },
    404: { description: "Workflow run not found" },
    400: { description: "Validation error" },
  },
  auth: { apiKey: true },
});

/**
 * Global broadcast: emits `name` on `workflowEventBus` with the raw payload.
 * Wait-states with `scope: 'global'` may resolve from these signals.
 */
const globalSignalRoute = route({
  method: "post",
  path: "/api/workflow-events",
  pattern: ["api", "workflow-events"],
  summary: "Fire a global workflow event signal",
  description:
    "Emits an event onto the workflow event bus. Wait-states with " +
    "`scope: 'global'` may match. Run-scoped waits will NOT match this " +
    "broadcast unless the payload carries a matching `workflowRunId`.",
  tags: ["WorkflowEvents"],
  body: z.object({
    name: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  responses: {
    200: { description: "Event emitted" },
    400: { description: "Validation error" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleWorkflowEvents(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  // POST /api/workflow-runs/{runId}/events
  if (runScopedSignalRoute.match(req.method, pathSegments)) {
    const parsed = await runScopedSignalRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const run = getWorkflowRun(parsed.params.runId);
    if (!run) {
      jsonError(res, "Workflow run not found", 404);
      return true;
    }

    const payload = { ...(parsed.body.payload ?? {}), _runId: parsed.params.runId };
    workflowEventBus.emit(parsed.body.name, payload);

    json(res, {
      ok: true,
      name: parsed.body.name,
      runId: parsed.params.runId,
    });
    return true;
  }

  // POST /api/workflow-events
  if (globalSignalRoute.match(req.method, pathSegments)) {
    const parsed = await globalSignalRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    workflowEventBus.emit(parsed.body.name, parsed.body.payload ?? {});

    json(res, { ok: true, name: parsed.body.name });
    return true;
  }

  return false;
}
