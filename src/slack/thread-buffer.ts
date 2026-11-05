import {
  getAgentById,
  getLatestActiveTaskInThread,
  getLeadAgent,
  getMostRecentTaskInThread,
} from "../be/db";
import { SteeringBlockedError } from "../be/steering";
import { findUserByExternalId } from "../be/users";
import { createAdditiveBuffer } from "../tasks/additive-buffer";
import { slackContextKey } from "../tasks/context-key";
import { TaskCreationBlockedError } from "../tasks/errors";
import { scrubSecrets } from "../utils/secret-scrubber";
import { ackSlackMessage, skipSlackMessageReaction } from "./ack";
import { getSlackApp } from "./app";
import { buildBufferFlushBlocks } from "./blocks";
import { resolveSlackUserId, rewriteSlackMentions } from "./enrich";
import type { SlackFile } from "./files";
import {
  bufferedFileFailures,
  buildEffectiveText,
  createSlackTaskWithFiles,
  fetchSlackFiles,
  notifySlackFileFailures,
} from "./inbound-files";
import { isSlackThreadLeft } from "./left-threads";
import { ensureSlackThreadTree, isSlackRenderV2Enabled } from "./render-v2";
import { getAgentDisplayName, getAgentSlackIcon } from "./responses";
import { formatSlackSteeringAck, requestSlackThreadSteering } from "./steering";
import { buildSlackThreadSnapshot } from "./thread-participants";
import { registerTreeMessage } from "./watcher";

interface BufferedMessage {
  text: string;
  userId: string;
  ts: string;
  channelId: string;
  threadTs: string;
  files?: SlackFile[];
  botUserId?: string;
  userTeam?: string;
}

const BUFFER_TIMEOUT_MS = Number(process.env.ADDITIVE_SLACK_BUFFER_MS) || 10_000;

function makeKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function splitKey(key: string): { channelId: string; threadTs: string } | null {
  const idx = key.indexOf(":");
  if (idx === -1) return null;
  return { channelId: key.slice(0, idx), threadTs: key.slice(idx + 1) };
}

const slackBuffer = createAdditiveBuffer<BufferedMessage>({
  timeoutMs: BUFFER_TIMEOUT_MS,
  label: "slack-thread",
  onFlush: async (items, key, reason) => {
    await slackFlush(items, key, reason === "manual");
  },
});

/**
 * Add a message to the thread buffer. Resets the debounce timer.
 */
export function bufferThreadMessage(
  channelId: string,
  threadTs: string,
  text: string,
  userId: string,
  ts: string,
  files?: SlackFile[],
  botUserId?: string,
  userTeam?: string,
): void {
  slackBuffer.enqueue(makeKey(channelId, threadTs), {
    text,
    userId,
    ts,
    channelId,
    threadTs,
    files,
    botUserId,
    userTeam,
  });
}

/**
 * Check if a thread currently has a pending buffer.
 */
export function isThreadBuffered(channelId: string, threadTs: string): boolean {
  return slackBuffer.isBuffered(makeKey(channelId, threadTs));
}

/**
 * Get the number of messages currently in the buffer for a thread key.
 */
export function getBufferMessageCount(key: string): number {
  return slackBuffer.count(key);
}

/**
 * Instantly flush the buffer (used by !now command). Clears the debounce timer
 * and flushes with immediate=true (no dependsOn).
 */
export async function instantFlush(key: string): Promise<void> {
  await slackBuffer.instantFlush(key);
}

/**
 * Flush the Slack thread buffer: concatenate messages, create task with optional
 * dependency chaining.
 */
async function slackFlush(
  items: BufferedMessage[],
  key: string,
  immediate: boolean,
): Promise<void> {
  if (items.length === 0) return;

  const split = splitKey(key);
  if (!split) {
    console.warn(`[Slack] Buffer flush: malformed key ${key}`);
    return;
  }
  const { channelId, threadTs } = split;
  // The thread was left (slack-leave-thread) while these replies waited. Only
  // non-mentions are buffered, so none of them rejoins it.
  if (await isSlackThreadLeft(channelId, threadTs)) {
    console.log(`[Slack] Buffer flush: dropping ${items.length} message(s) in left thread ${key}`);
    return;
  }
  // Buffer is guaranteed to have at least one item — the first carries the
  // original requester's userId (same semantics as the pre-refactor version).
  const originalRequesterId = items[0]!.userId;
  // Every buffered item is resolved from the same bot's auth.test() cache —
  // any item carrying it is representative of the whole flush.
  const botUserId = items.find((item) => item.botUserId)?.botUserId;

  console.log(`[Slack] Flushing buffer: ${key} (${items.length} messages, immediate=${immediate})`);

  // Keep only metadata during the debounce; downloads live for this flush only.
  const app = getSlackApp();
  const files = items.flatMap((item) => item.files ?? []);
  await using inbound = app
    ? await fetchSlackFiles(app.client, files, { transcribe: true })
    : {
        files,
        fetched: [],
        failed: bufferedFileFailures(files),
        async [Symbol.asyncDispose]() {},
      };
  const resolvedFiles = new Map(inbound.files.map((file) => [file.id, file]));

  // Any in-body `<@U…>` mentions are rewritten via the identity primitive so
  // the agent sees a name or the explicit UNKNOWN sentinel — never a raw Slack ID.
  const itemTexts = items.map((item) =>
    buildEffectiveText(
      item.text,
      item.files?.map((file) => resolvedFiles.get(file.id) ?? file),
      inbound.failed,
      inbound.notes,
    ),
  );
  const combinedText = await rewriteSlackMentions(itemTexts.join("\n---\n"), botUserId);

  // Find the latest active task in this thread for dependency chaining
  const latestActiveTask = await getLatestActiveTaskInThread(channelId, threadTs);
  if (latestActiveTask) {
    console.log(
      `[Slack] Dependency chaining: latest active task ${latestActiveTask.id} (status: ${latestActiveTask.status})`,
    );
  }

  const requestedByUserId = app
    ? await resolveSlackUserId(app.client, originalRequesterId, {
        sampleEventType: "buffered_thread_reply",
        sampleContext: items[0]!.text,
      })
    : (await findUserByExternalId("slack", originalRequesterId))?.id;

  // A steering row has one sender. Keep consecutive messages from that sender
  // together, then flush the remaining senders in order after successful delivery.
  const nextSenderIndex = items.findIndex((item) => item.userId !== originalRequesterId);
  const steeringItems = nextSenderIndex === -1 ? items : items.slice(0, nextSenderIndex);

  // Steering carries text only. As on the mention path, files need a follow-up
  // task so its attachments exist before a worker can claim it.
  let steering: Awaited<ReturnType<typeof requestSlackThreadSteering>>;
  try {
    steering =
      files.length === 0
        ? await requestSlackThreadSteering({
            channelId,
            threadTs,
            message:
              nextSenderIndex === -1
                ? combinedText
                : await rewriteSlackMentions(
                    steeringItems.map((item) => item.text).join("\n---\n"),
                    botUserId,
                  ),
            messageTimestamps: steeringItems.map((item) => item.ts),
            requestedByUserId,
            slackUserId: originalRequesterId,
          })
        : null;
  } catch (error) {
    if (!(error instanceof SteeringBlockedError)) throw error;
    console.info("[Slack] pre.task.steer blocked:", error.extension.name, error.reason);
    if (app) {
      for (const item of steeringItems) {
        await ackSlackMessage(app.client, channelId, item.ts, "no_entry");
      }
    }
    if (nextSenderIndex !== -1) {
      await slackFlush(items.slice(nextSenderIndex), key, immediate);
    }
    return;
  }
  if (steering) {
    console.log(
      `[Slack] Buffer flushed → steering ${steering.result.outcome} for task ${steering.task.id}`,
    );

    const agent = steering.task.agentId ? await getAgentById(steering.task.agentId) : undefined;
    if (app) {
      if (!isSlackRenderV2Enabled()) {
        try {
          await app.client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: formatSlackSteeringAck(steering.result),
            unfurl_links: false,
            unfurl_media: false,
            ...(agent ? { username: getAgentDisplayName(agent), ...getAgentSlackIcon(agent) } : {}),
          });
        } catch (error) {
          console.error("[Slack] Failed to post steering feedback:", error);
        }
      }
    }
    if (nextSenderIndex !== -1) {
      await slackFlush(items.slice(nextSenderIndex), key, immediate);
    }
    return;
  }

  const lead = await getLeadAgent();

  // Thread context, participants and trust, read once for the task.
  const snapshot = app
    ? await buildSlackThreadSnapshot(app.client, {
        channelId,
        threadTs,
        excludeTs: new Set(items.map((item) => item.ts)),
        botUserId,
        senders: items.map(({ userId, text, userTeam }) => ({ userId, text, userTeam })),
        sampleEventType: "buffered_thread_reply",
      })
    : undefined;
  // Each item names its sender; untrusted senders are tagged.
  const labelledText = await rewriteSlackMentions(
    items.map((item, index) => `<@${item.userId}>: ${itemTexts[index]}`).join("\n---\n"),
    botUserId,
    snapshot?.trust,
  );
  const description = `[Thread follow-up — ${items.length} message(s) buffered]\n\n${labelledText}`;
  const fullDescription = snapshot?.threadContext
    ? `${snapshot.threadContext}\n\n${description}`
    : description;
  // The newest sender caused this run: they own its attribution and budget.
  const newestSenderId = items.at(-1)!.userId;
  const newestRequesterId = app
    ? snapshot?.newest.userId
    : (await findUserByExternalId("slack", newestSenderId))?.id;

  // Always pending. If !now was used (immediate=true), no dependency.
  // Otherwise, depend on the latest active task so it queues naturally.
  const dependsOn = !immediate && latestActiveTask ? [latestActiveTask.id] : undefined;

  const mostRecentTask = await getMostRecentTaskInThread(channelId, threadTs);
  let created: Awaited<ReturnType<typeof createSlackTaskWithFiles>>;
  try {
    created = await createSlackTaskWithFiles(
      fullDescription,
      {
        agentId: lead?.id,
        routingReason:
          lead && mostRecentTask?.agentId === lead.id ? "continuity" : lead ? "skill" : undefined,
        routingSource: lead ? "engine_default" : undefined,
        source: "slack",
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        slackTriggerMessageTs: items.at(-1)!.ts,
        slackUserId: newestSenderId,
        slackParticipants: snapshot?.participants,
        requestedByUserId: newestRequesterId,
        dependsOn,
        parentTaskId: mostRecentTask?.id,
        // A human message in the thread: never answer it in the latest thread
        // task's structured-output contract.
        inheritParentOutputSchema: false,
        // An unregistered sender never inherits the parent's requester.
        inheritParentRequester: false,
        contextKey: slackContextKey({ channelId, threadTs }),
      },
      inbound,
      {
        trigger: "thread-buffer",
        messages: items.map(({ ts, userId, text }) => ({ ts, userId, text })),
      },
    );
  } catch (error) {
    if (!(error instanceof TaskCreationBlockedError)) throw error;

    console.info(
      "[Slack] pre.task.create blocked:",
      error.extension.name,
      scrubSecrets(error.reason),
    );
    if (app) {
      await skipSlackMessageReaction(app.client, channelId, items.at(-1)!.ts);
    }
    return;
  }
  const { task, unattached } = created;

  if (app) await notifySlackFileFailures(app.client, channelId, threadTs, unattached);

  console.log(
    `[Slack] Buffer flushed → task ${task.id} (dependsOn: ${dependsOn ? dependsOn.join(", ") : "none"})`,
  );

  if (isSlackRenderV2Enabled()) {
    await ensureSlackThreadTree([task.id]);
    return;
  }

  // Slack feedback with Block Kit
  if (app) {
    const hasDependency = !immediate && !!latestActiveTask;
    const blocks = buildBufferFlushBlocks({
      messageCount: items.length,
      taskId: task.id,
      hasDependency,
    });
    const fallbackText = hasDependency
      ? `${items.length} follow-up message(s) queued pending completion of current task`
      : `${items.length} follow-up message(s) batched into task`;

    try {
      const result = await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: fallbackText,
        unfurl_links: false,
        unfurl_media: false,
        ...(lead ? { username: getAgentDisplayName(lead), ...getAgentSlackIcon(lead) } : {}),
        // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
        blocks: blocks as any,
      });

      // Register the batching message as the tree message for this task
      if (result.ts && task) {
        await registerTreeMessage(task.id, channelId, threadTs, result.ts);
        console.log(
          `[Slack] Registered batched task ${task.id.slice(0, 8)} tree message from buffer flush`,
        );
      }
    } catch (error) {
      console.error("[Slack] Failed to post buffer flush feedback:", error);
    }
  }
}
