import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  assignTaskToEpic,
  createChannel,
  createEpic,
  createTaskExtended,
  deleteChannel,
  deleteEpic,
  getAgentById,
  getAllChannels,
  getChannelById,
  getChannelByName,
  getChannelMessages as getChannelMessagesDb,
  getEpicById,
  getEpics,
  getEpicWithProgress,
  getTasksByEpicId,
  postMessage,
  updateEpic,
} from "../be/db";
import type { EpicStatus } from "../types";
import { route } from "./route-def";
import { json, jsonError, parseBody } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listEpics = route({
  method: "get",
  path: "/api/epics",
  pattern: ["api", "epics"],
  summary: "List epics with optional filters",
  tags: ["Epics"],
  query: z.object({
    status: z.string().optional(),
    search: z.string().optional(),
    leadAgentId: z.string().optional(),
  }),
  responses: {
    200: { description: "Epic list with progress" },
  },
});

const createEpicRoute = route({
  method: "post",
  path: "/api/epics",
  pattern: ["api", "epics"],
  summary: "Create a new epic",
  tags: ["Epics"],
  body: z.object({
    name: z.string().min(1),
    goal: z.string().min(1),
    description: z.string().optional(),
    leadAgentId: z.string().optional(),
    repoId: z.string().optional(),
    branch: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  responses: {
    201: { description: "Epic created" },
    400: { description: "Validation error" },
  },
});

const getEpic = route({
  method: "get",
  path: "/api/epics/{id}",
  pattern: ["api", "epics", null],
  summary: "Get epic with progress and tasks",
  tags: ["Epics"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Epic with tasks" },
    404: { description: "Epic not found" },
  },
});

const updateEpicRoute = route({
  method: "put",
  path: "/api/epics/{id}",
  pattern: ["api", "epics", null],
  summary: "Update an epic",
  tags: ["Epics"],
  params: z.object({ id: z.string() }),
  body: z.record(z.string(), z.unknown()),
  responses: {
    200: { description: "Epic updated" },
    404: { description: "Epic not found" },
  },
});

const deleteEpicRoute = route({
  method: "delete",
  path: "/api/epics/{id}",
  pattern: ["api", "epics", null],
  summary: "Delete an epic",
  tags: ["Epics"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Epic deleted" },
    404: { description: "Epic not found" },
  },
});

const addTaskToEpic = route({
  method: "post",
  path: "/api/epics/{id}/tasks",
  pattern: ["api", "epics", null, "tasks"],
  summary: "Add task to epic (create new or assign existing)",
  tags: ["Epics"],
  params: z.object({ id: z.string() }),
  body: z.object({
    taskId: z.string().optional(),
    task: z.string().optional(),
    agentId: z.string().optional(),
    taskType: z.string().optional(),
    tags: z.array(z.string()).optional(),
    priority: z.number().int().optional(),
    offeredTo: z.string().optional(),
  }),
  responses: {
    200: { description: "Existing task assigned" },
    201: { description: "New task created in epic" },
    400: { description: "Missing task or taskId" },
    404: { description: "Epic or task not found" },
  },
});

const listChannels = route({
  method: "get",
  path: "/api/channels",
  pattern: ["api", "channels"],
  summary: "List all channels",
  tags: ["Channels"],
  responses: {
    200: { description: "Channel list" },
  },
});

const createChannelRoute = route({
  method: "post",
  path: "/api/channels",
  pattern: ["api", "channels"],
  summary: "Create a new channel",
  tags: ["Channels"],
  body: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    type: z.enum(["public", "dm"]).optional(),
  }),
  responses: {
    201: { description: "Channel created" },
    400: { description: "Validation error" },
    409: { description: "Duplicate name" },
  },
});

const deleteChannelRoute = route({
  method: "delete",
  path: "/api/channels/{id}",
  pattern: ["api", "channels", null],
  summary: "Delete a channel",
  tags: ["Channels"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Channel deleted" },
    400: { description: "Cannot delete general channel" },
    404: { description: "Channel not found" },
  },
});

const listChannelMessages = route({
  method: "get",
  path: "/api/channels/{id}/messages",
  pattern: ["api", "channels", null, "messages"],
  summary: "Get messages in a channel",
  tags: ["Channels"],
  params: z.object({ id: z.string() }),
  query: z.object({
    limit: z.coerce.number().int().min(1).optional(),
    since: z.string().optional(),
    before: z.string().optional(),
  }),
  responses: {
    200: { description: "Channel messages" },
    404: { description: "Channel not found" },
  },
});

const getThreadMessages = route({
  method: "get",
  path: "/api/channels/{channelId}/messages/{messageId}/thread",
  pattern: ["api", "channels", null, "messages", null, "thread"],
  summary: "Get thread messages for a message",
  tags: ["Channels"],
  params: z.object({ channelId: z.string(), messageId: z.string() }),
  responses: {
    200: { description: "Thread messages" },
    404: { description: "Channel not found" },
  },
});

const postMessageRoute = route({
  method: "post",
  path: "/api/channels/{id}/messages",
  pattern: ["api", "channels", null, "messages"],
  summary: "Post a message to a channel",
  tags: ["Channels"],
  params: z.object({ id: z.string() }),
  body: z.object({
    content: z.string().min(1),
    agentId: z.string().optional(),
    replyToId: z.string().optional(),
    mentions: z.array(z.string()).optional(),
  }),
  responses: {
    201: { description: "Message posted" },
    400: { description: "Invalid content or agentId" },
    404: { description: "Channel not found" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleEpics(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (listEpics.match(req.method, pathSegments)) {
    const parsed = await listEpics.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const rawEpics = getEpics({
      status: (parsed.query.status as EpicStatus) || undefined,
      search: parsed.query.search || undefined,
      leadAgentId: parsed.query.leadAgentId || undefined,
    });
    const epics = rawEpics.map((e) => getEpicWithProgress(e.id) ?? e);
    json(res, { epics, total: epics.length });
    return true;
  }

  if (createEpicRoute.match(req.method, pathSegments)) {
    const parsed = await createEpicRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const epic = createEpic({
        ...parsed.body,
        createdByAgentId: myAgentId || undefined,
      });
      json(res, epic, 201);
    } catch (_error) {
      jsonError(res, "Failed to create epic", 500);
    }
    return true;
  }

  if (getEpic.match(req.method, pathSegments)) {
    const parsed = await getEpic.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const epic = getEpicWithProgress(parsed.params.id);

    if (!epic) {
      jsonError(res, "Epic not found", 404);
      return true;
    }

    const tasks = getTasksByEpicId(parsed.params.id);
    json(res, { ...epic, tasks });
    return true;
  }

  if (updateEpicRoute.match(req.method, pathSegments)) {
    const parsed = await updateEpicRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const epic = updateEpic(parsed.params.id, parsed.body as Record<string, unknown>);
    if (!epic) {
      jsonError(res, "Epic not found", 404);
      return true;
    }
    json(res, epic);
    return true;
  }

  if (deleteEpicRoute.match(req.method, pathSegments)) {
    const parsed = await deleteEpicRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const deleted = deleteEpic(parsed.params.id);
    if (!deleted) {
      jsonError(res, "Epic not found", 404);
      return true;
    }
    json(res, { success: true });
    return true;
  }

  if (addTaskToEpic.match(req.method, pathSegments)) {
    const parsed = await addTaskToEpic.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const epic = getEpicById(parsed.params.id);

    if (!epic) {
      jsonError(res, "Epic not found", 404);
      return true;
    }

    // If taskId provided, assign existing task
    if (parsed.body.taskId) {
      const task = assignTaskToEpic(parsed.body.taskId, parsed.params.id);
      if (!task) {
        jsonError(res, "Task not found", 404);
        return true;
      }
      json(res, task);
      return true;
    }

    // Otherwise create new task in this epic
    if (!parsed.body.task) {
      jsonError(res, "Missing task description or taskId", 400);
      return true;
    }

    try {
      const task = createTaskExtended(parsed.body.task, {
        ...parsed.body,
        epicId: parsed.params.id,
        creatorAgentId: myAgentId || undefined,
        tags: [...(parsed.body.tags || []), `epic:${epic.name}`],
        source: "api",
      });
      json(res, task, 201);
    } catch (_error) {
      jsonError(res, "Failed to create task", 500);
    }
    return true;
  }

  if (listChannels.match(req.method, pathSegments)) {
    const channels = getAllChannels();
    json(res, { channels });
    return true;
  }

  if (createChannelRoute.match(req.method, pathSegments)) {
    const parsed = await createChannelRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const existing = getChannelByName(parsed.body.name);
    if (existing) {
      jsonError(res, "Channel with this name already exists", 409);
      return true;
    }

    try {
      const channel = createChannel(parsed.body.name, {
        description: parsed.body.description,
        type: parsed.body.type,
      });
      json(res, channel, 201);
    } catch (_error) {
      jsonError(res, "Failed to create channel", 500);
    }
    return true;
  }

  if (deleteChannelRoute.match(req.method, pathSegments)) {
    const parsed = await deleteChannelRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const GENERAL_CHANNEL_ID = "00000000-0000-4000-8000-000000000001";
    if (parsed.params.id === GENERAL_CHANNEL_ID) {
      jsonError(res, "Cannot delete the general channel", 400);
      return true;
    }

    const channel = getChannelById(parsed.params.id);
    if (!channel) {
      jsonError(res, "Channel not found", 404);
      return true;
    }

    const deleted = deleteChannel(parsed.params.id);
    if (!deleted) {
      jsonError(res, "Failed to delete channel", 500);
      return true;
    }

    json(res, { success: true });
    return true;
  }

  if (listChannelMessages.match(req.method, pathSegments)) {
    const parsed = await listChannelMessages.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const channel = getChannelById(parsed.params.id);
    if (!channel) {
      jsonError(res, "Channel not found", 404);
      return true;
    }

    const limit = parsed.query.limit ?? 50;
    const messages = getChannelMessagesDb(parsed.params.id, {
      limit,
      since: parsed.query.since || undefined,
      before: parsed.query.before || undefined,
    });
    json(res, { messages });
    return true;
  }

  if (getThreadMessages.match(req.method, pathSegments)) {
    const parsed = await getThreadMessages.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const channel = getChannelById(parsed.params.channelId);
    if (!channel) {
      jsonError(res, "Channel not found", 404);
      return true;
    }

    const allMessages = getChannelMessagesDb(parsed.params.channelId, { limit: 1000 });
    const threadMessages = allMessages.filter((m) => m.replyToId === parsed.params.messageId);
    json(res, { messages: threadMessages });
    return true;
  }

  if (postMessageRoute.match(req.method, pathSegments)) {
    const parsed = await postMessageRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const channel = getChannelById(parsed.params.id);
    if (!channel) {
      jsonError(res, "Channel not found", 404);
      return true;
    }

    const agentId = parsed.body.agentId || null;
    if (agentId) {
      const agent = getAgentById(agentId);
      if (!agent) {
        jsonError(res, "Invalid agentId", 400);
        return true;
      }
    }

    const message = postMessage(parsed.params.id, agentId, parsed.body.content, {
      replyToId: parsed.body.replyToId,
      mentions: parsed.body.mentions,
    });
    json(res, message, 201);
    return true;
  }

  return false;
}
