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

export async function handleActiveSessions(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "active-sessions" &&
    !pathSegments[2]
  ) {
    const agentId = queryParams.get("agentId");
    const sessions = getActiveSessions(agentId || undefined);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions }));
    return true;

  }

  // POST /api/active-sessions - Create a new active session
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "active-sessions" &&
    !pathSegments[2]
  ) {
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
  if (
    req.method === "DELETE" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "active-sessions" &&
    pathSegments[2] === "by-task" &&
    pathSegments[3]
  ) {
    const deleted = deleteActiveSession(pathSegments[3]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted }));
    return true;

  }

  // DELETE /api/active-sessions/:id - Delete by session id
  if (
    req.method === "DELETE" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "active-sessions" &&
    pathSegments[2]
  ) {
    const deleted = deleteActiveSessionById(pathSegments[2]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted }));
    return true;

  }

  // PUT /api/active-sessions/heartbeat/:taskId - Update heartbeat for a session
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "active-sessions" &&
    pathSegments[2] === "heartbeat" &&
    pathSegments[3]
  ) {
    const updated = heartbeatActiveSession(pathSegments[3]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ updated }));
    return true;

  }

  // POST /api/active-sessions/cleanup - Clean up stale sessions
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "active-sessions" &&
    pathSegments[2] === "cleanup" &&
    !pathSegments[3]
  ) {
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
