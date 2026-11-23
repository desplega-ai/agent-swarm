import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getWorkflowRun } from "../be/db";
import { isReservedProviderEvent } from "../event-waits";
import { isExtensionBridgedEvent } from "../extensions/post-bridge";
import { workflowEventBus } from "../workflows/event-bus";
import { route } from "./route-def";
import { jsonError } from "./utils";

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
  tags: ["Workflows"],
  params: z.object({ runId: z.string().uuid() }),
  body: z.object({
    name: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  responses: {
    200: {
      description: "Event emitted",
      schema: z.object({
        ok: z.literal(true),
        name: z.string(),
        runId: z.string(),
      }),
    },
    404: { description: "Workflow run not found" },
    403: { description: "Event name is reserved for provider webhooks or server-emitted events" },
    400: { description: "Validation error" },
  },
  auth: { apiKey: true },
  rbac: {
    ungated:
      "workflow runs: open to agents like the workflow tools; no verb covers them, so user roles need admin",
  },
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
  tags: ["Workflows"],
  body: z.object({
    name: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  responses: {
    200: {
      description: "Event emitted",
      schema: z.object({
        ok: z.literal(true),
        name: z.string(),
      }),
    },
    403: { description: "Event name is reserved for provider webhooks or server-emitted events" },
    400: { description: "Validation error" },
  },
  auth: { apiKey: true },
  rbac: {
    ungated:
      "workflow runs: open to agents like the workflow tools; no verb covers them, so user roles need admin",
  },
});

const RESERVED_EVENT_MESSAGE = "Event name is reserved for provider webhooks";
const SERVER_EVENT_MESSAGE = "Event name is reserved for server-emitted events";

/** The refusal message for a name only the server may emit, or null when callers may emit it. */
function reservedEventError(name: string): string | null {
  if (isReservedProviderEvent(name)) return RESERVED_EVENT_MESSAGE;
  // Extension handlers trust bridged payloads (approval outcomes, task and chat events).
  if (isExtensionBridgedEvent(name)) return SERVER_EVENT_MESSAGE;
  return null;
}

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

    const reserved = reservedEventError(parsed.body.name);
    if (reserved) {
      jsonError(res, reserved, 403);
      return true;
    }
    const run = await getWorkflowRun(parsed.params.runId);
    if (!run) {
      jsonError(res, "Workflow run not found", 404);
      return true;
    }

    const payload = { ...(parsed.body.payload ?? {}), _runId: parsed.params.runId };
    workflowEventBus.emit(parsed.body.name, payload);

    runScopedSignalRoute.respond(res, 200, {
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

    const reserved = reservedEventError(parsed.body.name);
    if (reserved) {
      jsonError(res, reserved, 403);
      return true;
    }
    workflowEventBus.emit(parsed.body.name, parsed.body.payload ?? {});

    globalSignalRoute.respond(res, 200, { ok: true, name: parsed.body.name });
    return true;
  }

  return false;
}
