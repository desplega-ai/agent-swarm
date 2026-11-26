import type { App } from "@slack/bolt";
import * as z from "zod";
import {
  cancelTask,
  getChildTasks,
  getSlackTasksInThread,
  updateAgentStatusFromCapacity,
} from "../be/db";
import { type AgentTask, isTerminalTaskStatus } from "../types";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { scrubSecrets } from "../utils/secret-scrubber";
import { shouldBlockChannel } from "./external-channel";
import { isUserAllowed, LOOKUP_USER_TEAM } from "./handlers";
import { ignoreSlackInbound, noteSlackInboundSideEffect } from "./inbound-dispatch";
import { reconcileSlackSessionStatus } from "./session-status";

/**
 * Slack's native Stop button (`agent_session_stopped`). Slack shows it in the
 * "Working…" line while a thread's session is `processing`, but only to apps
 * subscribed to the event, and it does not end the session itself: the app
 * stops the work and moves the status on. On by default; `false` turns it off.
 */
const SLACK_STOP_BUTTON_KEY = "SLACK_STOP_BUTTON_ENABLED";

/** Delegated tasks outside the thread a Stop walks at most; the thread's own tasks are always checked. */
const MAX_DELEGATED_TASKS = 500;
/** A delegator cancelled mid-walk may have created one more task; a further pass catches it. */
const STOP_PASSES = 2;

let warnedDisabled = false;

function isSlackStopButtonEnabled(): boolean {
  return isEnvFlagEnabled(SLACK_STOP_BUTTON_KEY, true);
}

/**
 * The open work a Stop in this thread ends: every non-terminal task in the
 * thread, then every non-terminal task delegated from one. Parents come first,
 * so no delegator is still running when its children are cancelled.
 */
async function openThreadWork(channelId: string, threadTs: string): Promise<AgentTask[]> {
  const threadTasks = await getSlackTasksInThread(channelId, threadTs);
  const seen = new Set(threadTasks.map((task) => task.id));
  const open = threadTasks.filter((task) => !isTerminalTaskStatus(task.status));
  const queue = threadTasks.map((task) => task.id);
  let delegated = 0;
  while (queue.length > 0 && delegated < MAX_DELEGATED_TASKS) {
    for (const child of await getChildTasks(queue.shift() as string)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      delegated++;
      if (!isTerminalTaskStatus(child.status)) open.push(child);
      queue.push(child.id);
    }
  }
  return open;
}

/** Cancels a thread's open work for `slackUserId` and returns how many tasks it ended. */
async function stopSlackThreadWork(input: {
  channelId: string;
  threadTs: string;
  slackUserId: string;
}): Promise<number> {
  const reason = `Stopped from Slack by <@${input.slackUserId}>`;
  let stopped = 0;
  for (let pass = 0; pass < STOP_PASSES; pass++) {
    const before = stopped;
    for (const task of await openThreadWork(input.channelId, input.threadTs)) {
      const cancelled = await cancelTask(task.id, reason, { statusKind: "user" });
      if (!cancelled) continue;
      stopped++;
      if (cancelled.agentId) await updateAgentStatusFromCapacity(cancelled.agentId);
    }
    if (stopped === before) break;
  }
  return stopped;
}

/** Bolt does not type this event yet. `team_id` is on the envelope, which the workspace gate checks. */
const StopEventSchema = z.object({
  channel: z.string().min(1),
  thread_ts: z.string().min(1),
  user: z.string().min(1),
});

export function registerSessionStopHandler(app: App): void {
  app.event("agent_session_stopped", async ({ event, client }) => {
    if (!isSlackStopButtonEnabled()) {
      if (!warnedDisabled) {
        warnedDisabled = true;
        console.warn(
          `[Slack] Ignoring a Stop click: the Slack app subscribes to agent_session_stopped but ${SLACK_STOP_BUTTON_KEY} is off.`,
        );
      }
      return ignoreSlackInbound("stop_button_disabled");
    }
    const parsed = StopEventSchema.safeParse(event);
    if (!parsed.success) return ignoreSlackInbound("stop_malformed");
    const { channel: channelId, thread_ts: threadTs, user: slackUserId } = parsed.data;

    // The same gates as the Cancel button: an internal channel and a sender the message handler accepts.
    if (await shouldBlockChannel(client, channelId)) return ignoreSlackInbound("external_channel");
    if (!(await isUserAllowed(client, slackUserId, LOOKUP_USER_TEAM))) {
      console.log(
        scrubSecrets(
          `[Slack] Ignoring Stop in ${channelId}/${threadTs} from unauthorized user ${slackUserId}`,
        ),
      );
      return ignoreSlackInbound("unauthorized_user");
    }

    noteSlackInboundSideEffect("session_stopped");
    const stopped = await stopSlackThreadWork({ channelId, threadTs, slackUserId });
    console.log(`[Slack] Stop in ${channelId}/${threadTs} cancelled ${stopped} task(s)`);
    // The task events re-render the tree, reactions and outcome card; the status is ours to move.
    await reconcileSlackSessionStatus({ channelId, threadTs, client, stopped: true });
  });
}
