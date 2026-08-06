import { createLogEntry, getLatestActiveTaskInThread, getLatestLeadTaskInThread } from "../be/db";
import { requestSteering } from "../be/steering";
import type { AgentTask, SteerResult } from "../types";
import { isSteeringEnabled } from "../utils/steering-enabled";

export interface SlackThreadSteeringRequest {
  channelId: string;
  threadTs: string;
  message: string;
  messageTimestamps?: string[];
  requestedByUserId?: string;
}

export interface SlackThreadSteeringResult {
  task: AgentTask;
  result: SteerResult;
}

function configuredSteeringTarget(channelId: string, threadTs: string): AgentTask | null {
  switch (process.env.SLACK_THREAD_STEERING) {
    case "lead":
      return getLatestLeadTaskInThread(channelId, threadTs);
    case "all":
      return getLatestActiveTaskInThread(channelId, threadTs);
    default:
      return null;
  }
}

/**
 * Request steering for the configured Slack thread target, if it is currently
 * in progress. The default and invalid configuration values deliberately
 * return null so Slack preserves its existing task-creation behavior.
 */
export function requestSlackThreadSteering(
  args: SlackThreadSteeringRequest,
): SlackThreadSteeringResult | null {
  if (!isSteeringEnabled()) return null;

  const task = configuredSteeringTarget(args.channelId, args.threadTs);
  if (!task || task.status !== "in_progress") return null;

  const mode = process.env.SLACK_THREAD_STEERING_MODE === "steer" ? "steer" : "queue";
  const result = requestSteering({
    taskId: task.id,
    message: args.message,
    mode,
    onUnsupported: "degrade",
    source: "slack",
    createdByKind: "user",
    createdByUserId: args.requestedByUserId,
  });
  for (const messageTs of args.messageTimestamps ?? []) {
    createLogEntry({
      eventType: "task_steering",
      taskId: task.id,
      newValue: "slack_reaction",
      metadata: { slackChannelId: args.channelId, slackMessageTs: messageTs },
    });
  }

  return { task, result };
}

/** Build an honest thread acknowledgement for the core service outcome. */
export function formatSlackSteeringAck(result: SteerResult): string {
  if (result.outcome === "promoted") {
    return ":speech_balloon: _Your message was queued as a follow-up task._";
  }
  if (result.degradedFrom) {
    return ":speech_balloon: _Interrupt steering is unavailable for this task, so your message was queued._";
  }
  return result.outcome === "steered"
    ? ":speech_balloon: _Your steering message was sent to the active task._"
    : ":speech_balloon: _Your steering message was queued for the active task._";
}
