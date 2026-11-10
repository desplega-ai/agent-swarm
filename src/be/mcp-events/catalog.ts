/**
 * MCP Events offered on the user MCP. v1: webhook delivery of task.completed
 * and task.failed for tasks the subscribing user requested.
 */

import { parseEnvFlag } from "@/utils/env-flag";

/** SEP-3415 extension identifier. */
export const EVENTS_EXTENSION_ID = "io.modelcontextprotocol/events";

/**
 * Kill switch, default on. Off: no capability advertised and every `events/*`
 * request gets -32601 Method not found. Read per session, so a config change
 * applies to new sessions without a restart.
 */
export function isMcpUserEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseEnvFlag(env.MCP_USER_EVENTS_ENABLED, true);
}

/**
 * SEP-3415 error codes (draft, "provisional until accepted"). OpenAI's
 * ChatGPT page still cites -32015 for CallbackEndpointError, from an earlier
 * revision of the design sketch that used -32011..-32015.
 */
export const EventsErrorCode = {
  InvalidParams: -32602,
  NotFound: -32023,
  Forbidden: -32024,
  ResourceExhausted: -32025,
  Unsupported: -32026,
  CallbackEndpointError: -32027,
} as const;

export type TaskEventName = "task.completed" | "task.failed";

const ARGUMENTS_SCHEMA = {
  type: "object",
  properties: {
    taskId: {
      type: "string",
      description:
        "Only this task and the tasks created under it. Omit to receive every task you requested.",
    },
  },
  additionalProperties: false,
} as const;

const BASE_PAYLOAD_PROPERTIES = {
  taskId: { type: "string" },
  parentTaskId: { type: ["string", "null"] },
  status: { type: "string" },
  task: { type: "string", description: "The task description, truncated." },
  url: { type: "string", description: "Dashboard link to the task." },
} as const;

export const EVENT_DESCRIPTORS = [
  {
    name: "task.completed",
    description:
      "Fires when a task you requested completes. Read the full result with get-task-details.",
    delivery: ["webhook"],
    inputSchema: ARGUMENTS_SCHEMA,
    payloadSchema: {
      type: "object",
      properties: {
        ...BASE_PAYLOAD_PROPERTIES,
        output: { type: "string", description: "The task output, truncated." },
        truncated: { type: "boolean" },
      },
      required: ["taskId", "status", "url"],
    },
  },
  {
    name: "task.failed",
    description: "Fires when a task you requested fails. Read the details with get-task-details.",
    delivery: ["webhook"],
    inputSchema: ARGUMENTS_SCHEMA,
    payloadSchema: {
      type: "object",
      properties: {
        ...BASE_PAYLOAD_PROPERTIES,
        failureReason: { type: "string", description: "Why the task failed, truncated." },
        truncated: { type: "boolean" },
      },
      required: ["taskId", "status", "url"],
    },
  },
] as const;

export function isTaskEventName(name: unknown): name is TaskEventName {
  return name === "task.completed" || name === "task.failed";
}

export type TaskEventArguments = { taskId?: string };

/** Validates `arguments` against ARGUMENTS_SCHEMA. Returns null when invalid. */
export function parseTaskEventArguments(raw: unknown): TaskEventArguments | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  const out: TaskEventArguments = {};
  for (const [key, value] of entries) {
    if (key !== "taskId") return null;
    if (typeof value !== "string" || value.length === 0 || value.length > 200) return null;
    out.taskId = value;
  }
  return out;
}
