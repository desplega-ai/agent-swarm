import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assignTaskToEpic,
  createEpic,
  createTaskExtended,
  deleteEpic,
  getAgentById,
  getAllChannels,
  getChannelById,
  getChannelMessages,
  getEpicById,
  getEpicWithProgress,
  getEpics,
  getTasksByEpicId,
  postMessage,
  updateEpic,
} from "../be/db";
import type { EpicStatus } from "../types";

export async function handleEpics(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "epics" &&
    !pathSegments[2]
  ) {
    const status = queryParams.get("status") as EpicStatus | null;
    const search = queryParams.get("search");
    const leadAgentId = queryParams.get("leadAgentId");
    const rawEpics = getEpics({
      status: status || undefined,
      search: search || undefined,
      leadAgentId: leadAgentId || undefined,
    });
    // Enrich each epic with progress data for the UI
    const epics = rawEpics.map((e) => getEpicWithProgress(e.id) ?? e);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ epics, total: epics.length }));
    return true;

  }

  // POST /api/epics - Create a new epic
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "epics" &&
    !pathSegments[2]
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!body.name || !body.goal) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: name, goal" }));
      return true;

    }

    try {
      const epic = createEpic({
        ...body,
        createdByAgentId: myAgentId || undefined,
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(epic));
    } catch (_error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to create epic" }));
    }
    return true;

  }

  // GET /api/epics/:id - Get single epic with progress and tasks
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "epics" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const epicId = pathSegments[2];
    const epic = getEpicWithProgress(epicId);

    if (!epic) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Epic not found" }));
      return true;

    }

    const tasks = getTasksByEpicId(epicId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...epic, tasks }));
    return true;

  }

  // PUT /api/epics/:id - Update an epic
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "epics" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const epicId = pathSegments[2];
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    const epic = updateEpic(epicId, body);
    if (!epic) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Epic not found" }));
      return true;

    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(epic));
    return true;

  }

  // DELETE /api/epics/:id - Delete an epic
  if (
    req.method === "DELETE" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "epics" &&
    pathSegments[2] &&
    !pathSegments[3]
  ) {
    const epicId = pathSegments[2];
    const deleted = deleteEpic(epicId);

    if (!deleted) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Epic not found" }));
      return true;

    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return true;

  }

  // POST /api/epics/:id/tasks - Add task to epic (create new or assign existing)
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "epics" &&
    pathSegments[2] &&
    pathSegments[3] === "tasks"
  ) {
    const epicId = pathSegments[2];
    const epic = getEpicById(epicId);

    if (!epic) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Epic not found" }));
      return true;

    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // If taskId provided, assign existing task
    if (body.taskId) {
      const task = assignTaskToEpic(body.taskId, epicId);
      if (!task) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Task not found" }));
        return true;

      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(task));
      return true;

    }

    // Otherwise create new task in this epic
    if (!body.task) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing task description or taskId" }));
      return true;

    }

    try {
      const task = createTaskExtended(body.task, {
        ...body,
        epicId,
        creatorAgentId: myAgentId || undefined,
        tags: [...(body.tags || []), `epic:${epic.name}`],
        source: "api",
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(task));
    } catch (_error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to create task" }));
    }
    return true;

  }

  // GET /api/channels - List all channels
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "channels" &&
    !pathSegments[2]
  ) {
    const channels = getAllChannels();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ channels }));
    return true;

  }

  // GET /api/channels/:id/messages - Get messages in a channel
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "channels" &&
    pathSegments[2] &&
    pathSegments[3] === "messages" &&
    !pathSegments[4]
  ) {
    const channelId = pathSegments[2];
    const channel = getChannelById(channelId);

    if (!channel) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Channel not found" }));
      return true;

    }

    const limitParam = queryParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 50;
    const since = queryParams.get("since") || undefined;
    const before = queryParams.get("before") || undefined;

    const messages = getChannelMessages(channelId, { limit, since, before });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages }));
    return true;

  }

  // GET /api/channels/:id/messages/:messageId/thread - Get thread messages
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "channels" &&
    pathSegments[2] &&
    pathSegments[3] === "messages" &&
    pathSegments[4] &&
    pathSegments[5] === "thread"
  ) {
    const channelId = pathSegments[2];
    const parentMessageId = pathSegments[4];

    const channel = getChannelById(channelId);
    if (!channel) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Channel not found" }));
      return true;

    }

    // Get all messages that reply to this message
    const allMessages = getChannelMessages(channelId, { limit: 1000 });
    const threadMessages = allMessages.filter((m) => m.replyToId === parentMessageId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages: threadMessages }));
    return true;

  }

  // POST /api/channels/:id/messages - Post a message
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "channels" &&
    pathSegments[2] &&
    pathSegments[3] === "messages"
  ) {
    const channelId = pathSegments[2];
    const channel = getChannelById(channelId);

    if (!channel) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Channel not found" }));
      return true;

    }

    // Parse request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    if (!body.content || typeof body.content !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid content" }));
      return true;

    }

    // agentId is optional (null for human users)
    const agentId = body.agentId || null;

    // If agentId provided, verify agent exists
    if (agentId) {
      const agent = getAgentById(agentId);
      if (!agent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid agentId" }));
        return true;

      }
    }

    const message = postMessage(channelId, agentId, body.content, {
      replyToId: body.replyToId,
      mentions: body.mentions,
    });

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(message));
    return true;

  }


  return false;
}
