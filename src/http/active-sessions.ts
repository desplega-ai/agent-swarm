import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  cleanupAgentSessions,
  cleanupStaleSessions,
  deleteActiveSession,
  deleteActiveSessionById,
  getActiveSessions,
  heartbeatActiveSession,
  insertActiveSession,
  updateActiveSessionProviderSessionId,
} from "../be/db";
import { route } from "./route-def";
import { json } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listActiveSessions = route({
  method: "get",
  path: "/api/active-sessions",
  pattern: ["api", "active-sessions"],
  summary: "List active sessions",
  tags: ["Active Sessions"],
  query: z.object({
    agentId: z.string().uuid().optional(),
  }),
  responses: {
    200: { description: "Active session list" },
  },
});

const createActiveSession = route({
  method: "post",
  path: "/api/active-sessions",
  pattern: ["api", "active-sessions"],
  summary: "Create a new active session",
  tags: ["Active Sessions"],
  body: z.object({
    agentId: z.string().min(1),
    taskId: z.string().optional(),
    triggerType: z.string().min(1),
    inboxMessageId: z.string().optional(),
    taskDescription: z.string().optional(),
    runnerSessionId: z.string().optional(),
  }),
  responses: {
    201: { description: "Session created" },
    400: { description: "Validation error" },
  },
});

const deleteSessionByTask = route({
  method: "delete",
  path: "/api/active-sessions/by-task/{taskId}",
  pattern: ["api", "active-sessions", "by-task", null],
  summary: "Delete active session by task ID",
  tags: ["Active Sessions"],
  params: z.object({ taskId: z.string() }),
  responses: {
    200: { description: "Session deleted" },
  },
});

const deleteSessionById = route({
  method: "delete",
  path: "/api/active-sessions/{id}",
  pattern: ["api", "active-sessions", null],
  summary: "Delete active session by ID",
  tags: ["Active Sessions"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Session deleted" },
  },
});

const heartbeatSession = route({
  method: "put",
  path: "/api/active-sessions/heartbeat/{taskId}",
  pattern: ["api", "active-sessions", "heartbeat", null],
  summary: "Update heartbeat for an active session",
  tags: ["Active Sessions"],
  params: z.object({ taskId: z.string() }),
  responses: {
    200: { description: "Heartbeat updated" },
  },
});

const updateProviderSession = route({
  method: "put",
  path: "/api/active-sessions/provider-session/{taskId}",
  pattern: ["api", "active-sessions", "provider-session", null],
  summary: "Update provider session ID on an active session",
  tags: ["Active Sessions"],
  params: z.object({ taskId: z.string() }),
  body: z.object({ providerSessionId: z.string().min(1) }),
  responses: {
    200: { description: "Provider session ID updated" },
  },
});

const cleanupSessions = route({
  method: "post",
  path: "/api/active-sessions/cleanup",
  pattern: ["api", "active-sessions", "cleanup"],
  summary: "Clean up stale sessions",
  tags: ["Active Sessions"],
  body: z
    .object({
      agentId: z.string().optional(),
      maxAgeMinutes: z.number().int().optional(),
    })
    .optional(),
  responses: {
    200: { description: "Cleanup result" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleActiveSessions(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  _myAgentId: string | undefined,
): Promise<boolean> {
  if (listActiveSessions.match(req.method, pathSegments)) {
    const parsed = await listActiveSessions.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const sessions = getActiveSessions(parsed.query.agentId || undefined);
    json(res, { sessions });
    return true;
  }

  if (createActiveSession.match(req.method, pathSegments)) {
    const parsed = await createActiveSession.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const session = insertActiveSession({
      agentId: parsed.body.agentId,
      taskId: parsed.body.taskId,
      triggerType: parsed.body.triggerType,
      inboxMessageId: parsed.body.inboxMessageId,
      taskDescription: parsed.body.taskDescription,
      runnerSessionId: parsed.body.runnerSessionId,
    });
    json(res, { session }, 201);
    return true;
  }

  if (deleteSessionByTask.match(req.method, pathSegments)) {
    const parsed = await deleteSessionByTask.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const deleted = deleteActiveSession(parsed.params.taskId);
    json(res, { deleted });
    return true;
  }

  if (deleteSessionById.match(req.method, pathSegments)) {
    const parsed = await deleteSessionById.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const deleted = deleteActiveSessionById(parsed.params.id);
    json(res, { deleted });
    return true;
  }

  if (heartbeatSession.match(req.method, pathSegments)) {
    const parsed = await heartbeatSession.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const updated = heartbeatActiveSession(parsed.params.taskId);
    json(res, { updated });
    return true;
  }

  if (updateProviderSession.match(req.method, pathSegments)) {
    const parsed = await updateProviderSession.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const updated = updateActiveSessionProviderSessionId(
      parsed.params.taskId,
      parsed.body.providerSessionId,
    );
    json(res, { updated });
    return true;
  }

  if (cleanupSessions.match(req.method, pathSegments)) {
    const parsed = await cleanupSessions.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    let cleaned = 0;
    if (parsed.body?.agentId) {
      cleaned = cleanupAgentSessions(parsed.body.agentId);
    } else {
      cleaned = cleanupStaleSessions(parsed.body?.maxAgeMinutes ?? 30);
    }
    json(res, { cleaned });
    return true;
  }

  return false;
}
