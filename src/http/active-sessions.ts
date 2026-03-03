import type { IncomingMessage, ServerResponse } from "node:http";
import {
  cleanupAgentSessions,
  cleanupStaleSessions,
  deleteActiveSession,
  deleteActiveSessionById,
  getActiveSessions,
  heartbeatActiveSession,
  insertActiveSession,
} from "../be/db";
import { matchRoute } from "./utils";

export async function handleActiveSessions(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (matchRoute(req.method, pathSegments, "GET", ["api", "active-sessions"], true)) {
    const agentId = queryParams.get("agentId");
    const sessions = getActiveSessions(agentId || undefined);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions }));
    return true;
  }

  // POST /api/active-sessions - Create a new active session
  if (matchRoute(req.method, pathSegments, "POST", ["api", "active-sessions"], true)) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    let body: {
      agentId?: string;
      taskId?: string;
      triggerType?: string;
      inboxMessageId?: string;
      taskDescription?: string;
    };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return true;
    }
    if (!body.agentId || !body.triggerType) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "agentId and triggerType are required" }));
      return true;
    }
    const session = insertActiveSession({
      agentId: body.agentId,
      taskId: body.taskId,
      triggerType: body.triggerType,
      inboxMessageId: body.inboxMessageId,
      taskDescription: body.taskDescription,
    });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ session }));
    return true;
  }

  // DELETE /api/active-sessions/by-task/:taskId - Delete by taskId
  if (matchRoute(req.method, pathSegments, "DELETE", ["api", "active-sessions", "by-task", null])) {
    const deleted = deleteActiveSession(pathSegments[3]!);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted }));
    return true;
  }

  // DELETE /api/active-sessions/:id - Delete by session id
  if (matchRoute(req.method, pathSegments, "DELETE", ["api", "active-sessions", null])) {
    const deleted = deleteActiveSessionById(pathSegments[2]!);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted }));
    return true;
  }

  // PUT /api/active-sessions/heartbeat/:taskId - Update heartbeat for a session
  if (matchRoute(req.method, pathSegments, "PUT", ["api", "active-sessions", "heartbeat", null])) {
    const updated = heartbeatActiveSession(pathSegments[3]!);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ updated }));
    return true;
  }

  // POST /api/active-sessions/cleanup - Clean up stale sessions
  if (matchRoute(req.method, pathSegments, "POST", ["api", "active-sessions", "cleanup"], true)) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    let body: { agentId?: string; maxAgeMinutes?: number } = {};
    try {
      const text = Buffer.concat(chunks).toString();
      if (text) body = JSON.parse(text);
    } catch {
      // Empty body is fine — defaults apply
    }
    let cleaned = 0;
    if (body.agentId) {
      cleaned = cleanupAgentSessions(body.agentId);
    } else {
      cleaned = cleanupStaleSessions(body.maxAgeMinutes ?? 30);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cleaned }));
    return true;
  }

  return false;
}
