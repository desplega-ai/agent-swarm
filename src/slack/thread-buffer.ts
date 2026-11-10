import {
  getAgentById,
  getLatestActiveTaskInThread,
  getLatestLeadTaskInThread,
  getLeadAgent,
  getMostRecentTaskInThread,
} from "../be/db";
import { foldIntoPendingSlackTask, getDeliveredSlackMessageTs } from "../be/db/tasks/slack-fold";
import { SteeringBlockedError } from "../be/steering";
import { findUserByExternalId } from "../be/users";
import { applyPreTaskCreate } from "../extensions/apply-task-create";
import { createAdditiveBuffer } from "../tasks/additive-buffer";
import { slackContextKey } from "../tasks/context-key";
import { TaskCreationBlockedError } from "../tasks/errors";
import type { Agent, AgentTask, CreateTaskOptions, TaskSlackParticipants } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { ackSlackMessage, reactionName, skipSlackMessageReaction } from "./ack";
import { getSlackApp } from "./app";
import { buildBufferFlushBlocks } from "./blocks";
import { resolveSlackUserId, rewriteSlackMentions } from "./enrich";
import type { SlackFile } from "./files";
import {
  attachSlackFilesToDraft,
  bufferedFileFailures,
  buildEffectiveText,
  createSlackTaskWithFiles,
  fetchSlackFiles,
  notifySlackFileFailures,
  type SlackFileFailure,
} from "./inbound-files";
import { isSlackThreadLeft } from "./left-threads";
import { ensureSlackThreadPresentation, isSlackRenderV2Enabled } from "./render-v2";
import { getAgentDisplayName, getAgentSlackIcon } from "./responses";
import { formatSlackFoldAck, formatSlackSteeringAck, requestSlackThreadSteering } from "./steering";
import type { BufferedMessage } from "./thread-buffer-store";
import * as bufferStore from "./thread-buffer-store";
import {
  buildSlackThreadSnapshot,
  formatAuthoredMessage,
  SLACK_PARTICIPANT_CAP,
} from "./thread-participants";
import { registerTreeMessage } from "./watcher";

const BUFFER_TIMEOUT_MS = Number(process.env.ADDITIVE_SLACK_BUFFER_MS) || 10_000;
/** Folds tried before a flush gives up on a pending task that keeps changing under it. */
const FOLD_ATTEMPTS = 3;
/** The follow-up header at the start of a task body (see `followUpBodyStart`). */
const FOLLOW_UP_HEADER_RE = /^\[Thread follow-up — (\d+) message\(s\) buffered\]\n/;
const SIBLING_CLOSE = "</sibling_tasks_in_progress>";
const CONTEXT_CLOSE = "\n</thread_context>";

function followUpHeader(count: number): string {
  return `[Thread follow-up — ${count} message(s) buffered]`;
}

/**
 * Where a Slack task's own text starts: after the sibling block the creation
 * path may prepend, then after the `<thread_context>` block. The template
 * closes the context at column 0, where no quoted message line can start.
 * This is the one place a follow-up header belongs; slack-reply-gate's
 * `parseFollowUp` anchors on it there.
 */
function followUpBodyStart(description: string): number {
  let at = 0;
  const skipBlock = (open: string, close: string) => {
    if (!description.startsWith(open, at)) return;
    const end = description.indexOf(close, at);
    if (end === -1) return;
    at = end + close.length;
    while (at < description.length && /\s/.test(description[at]!)) at += 1;
  };
  skipBlock("<sibling_tasks_in_progress>", SIBLING_CLOSE);
  skipBlock("<thread_context>", CONTEXT_CLOSE);
  return at;
}

/**
 * Append newly buffered messages to a pending task's text, keeping exactly one
 * follow-up header, right where a buffered follow-up has it. A task whose body
 * opens with the header (a buffered follow-up, or an earlier fold) gets its
 * count bumped in place and the messages appended after its own. Any other
 * task (an @mention) gets the header in front of its ask, which becomes the
 * first message under it. A header line inside a user's message is never at
 * that position, so it is never taken as the task's.
 */
export function appendFollowUpMessages(description: string, labelled: string, count: number) {
  const bodyStart = followUpBodyStart(description);
  const head = description.slice(0, bodyStart);
  const body = description.slice(bodyStart);
  const own = FOLLOW_UP_HEADER_RE.exec(body);
  if (own) {
    const total = Number(own[1]) + count;
    return `${head}${followUpHeader(total)}\n${body.slice(own[0].length)}\n---\n${labelled}`;
  }
  const before = head.trimEnd() ? `${head.trimEnd()}\n\n` : "";
  const ask = body.trim();
  return ask
    ? `${before}${followUpHeader(count + 1)}\n\n${ask}\n---\n${labelled}`
    : `${before}${followUpHeader(count)}\n\n${labelled}`;
}

/**
 * The thread's pending Lead task, if buffered messages can be folded into it:
 * a Slack-path task (no taskType: never a worker follow-up or a resume) for
 * this thread's contextKey that no worker has claimed yet. A `!now` flush asks
 * for an immediate run, so it never joins a task queued behind another one.
 * The newest sender owns a run's attribution and budget, so a flush folds only
 * into a task requested by that same user; anyone else gets a task of their own.
 */
function isFoldTarget(
  task: AgentTask | null,
  channelId: string,
  threadTs: string,
  leadId: string | undefined,
  immediate: boolean,
  requesterId: string | undefined,
): task is AgentTask {
  if (
    !leadId ||
    !task ||
    (task.requestedByUserId ?? undefined) !== requesterId ||
    task.status !== "pending" ||
    task.agentId !== leadId ||
    task.source !== "slack" ||
    task.taskType ||
    task.offeredTo ||
    task.contextKey !== slackContextKey({ channelId, threadTs })
  ) {
    return false;
  }
  return !(immediate && task.dependsOn.length > 0);
}

/**
 * The folded task's people: its own, then the new senders. The trigger stays
 * the task's, so `newest` is never moved; new senders are marked `asked`.
 */
function foldParticipants(
  previous: TaskSlackParticipants | undefined,
  snapshot: TaskSlackParticipants,
): TaskSlackParticipants {
  const people = [...(previous?.people ?? [])];
  const index = new Map(people.map((person, at) => [person.slackUserId, at]));
  // shortcut: `more` is approximate (max of both counts plus overflow); count distinct ids if the prompt ever shows it exactly.
  let more = Math.max(previous?.more ?? 0, snapshot.more);
  for (const { newest: _newest, ...person } of snapshot.people) {
    const at = index.get(person.slackUserId);
    if (at !== undefined) {
      const current = people[at]!;
      people[at] = {
        ...current,
        trust: person.trust,
        ...(person.userId && { userId: person.userId }),
        ...(person.asked && { asked: true }),
      };
    } else if (people.length < SLACK_PARTICIPANT_CAP) {
      index.set(person.slackUserId, people.length);
      people.push(person);
    } else {
      more += 1;
    }
  }
  return { people, more };
}

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
    // Only a flush that returned is done with its rows; a throw keeps them for the next boot.
    await bufferStore.clear(items);
  },
});

/**
 * Add a message to the thread buffer. Resets the debounce timer. The message
 * is stored first, so a restart before the flush replays it.
 */
export async function bufferThreadMessage(
  channelId: string,
  threadTs: string,
  text: string,
  userId: string,
  ts: string,
  files?: SlackFile[],
  botUserId?: string,
  userTeam?: string,
): Promise<void> {
  const item = { text, userId, ts, channelId, threadTs, files, botUserId, userTeam };
  try {
    await bufferStore.persist(item);
  } catch (error) {
    // Still buffer in memory: losing durability beats losing the message now.
    console.error(`[Slack] Failed to persist buffered message ${ts}:`, error);
  }
  slackBuffer.enqueue(makeKey(channelId, threadTs), item);
}

let restored = false;

/**
 * Re-buffer the messages a restart interrupted, once per process. They flush
 * on the usual timer; the flush drops any a task already carries, so a crash
 * between task creation and the row delete creates no second task.
 */
export async function restoreBufferedSlackMessages(): Promise<number> {
  if (restored) return 0;
  restored = true;
  let items: BufferedMessage[];
  try {
    items = await bufferStore.loadAll();
  } catch (error) {
    restored = false; // the next connect retries
    throw error;
  }
  for (const item of items) slackBuffer.enqueue(makeKey(item.channelId, item.threadTs), item);
  if (items.length > 0) {
    console.log(`[Slack] Restored ${items.length} buffered thread message(s) after restart`);
  }
  return items.length;
}

export function resetSlackBufferRestoreForTests(): void {
  restored = false;
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
 * Slack feedback for messages folded into a pending task: each message is
 * acknowledged, and the thread shows the task's tree (render v2) or a short
 * note (legacy). The task already has its own tree card, so none is added.
 */
async function postFoldFeedback(args: {
  channelId: string;
  threadTs: string;
  taskId: string;
  items: BufferedMessage[];
  unattached: SlackFileFailure[];
  lead: Agent | null | undefined;
}): Promise<void> {
  const { channelId, threadTs, items, lead } = args;
  const app = getSlackApp();
  if (app) {
    for (const item of items) {
      await ackSlackMessage(app.client, channelId, item.ts, reactionName("accepted"), "accepted");
    }
    await notifySlackFileFailures(app.client, channelId, threadTs, args.unattached);
  }
  if (isSlackRenderV2Enabled()) {
    await ensureSlackThreadPresentation([args.taskId]);
    return;
  }
  if (!app) return;
  try {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: formatSlackFoldAck(items.length),
      unfurl_links: false,
      unfurl_media: false,
      ...(lead ? { username: getAgentDisplayName(lead), ...getAgentSlackIcon(lead) } : {}),
    });
  } catch (error) {
    console.error("[Slack] Failed to post buffer fold feedback:", error);
  }
}

/**
 * Flush the Slack thread buffer: concatenate messages, create task with optional
 * dependency chaining.
 */
async function slackFlush(
  bufferedItems: BufferedMessage[],
  key: string,
  immediate: boolean,
  foldAttempts = FOLD_ATTEMPTS,
): Promise<void> {
  if (bufferedItems.length === 0) return;

  const split = splitKey(key);
  if (!split) {
    console.warn(`[Slack] Buffer flush: malformed key ${key}`);
    return;
  }
  const { channelId, threadTs } = split;
  // The thread was left (slack-leave-thread) while these replies waited. Only
  // non-mentions are buffered, so none of them rejoins it.
  if (await isSlackThreadLeft(channelId, threadTs)) {
    console.log(
      `[Slack] Buffer flush: dropping ${bufferedItems.length} message(s) in left thread ${key}`,
    );
    return;
  }
  // A message a task in this thread already carries (its trigger, or one
  // steered or folded into it) is never delivered again: a Slack retry after a
  // restart buffers the same message a second time.
  const delivered = await getDeliveredSlackMessageTs(channelId, threadTs);
  const items = bufferedItems.filter((item) => {
    if (delivered.has(item.ts)) return false;
    delivered.add(item.ts);
    return true;
  });
  if (items.length < bufferedItems.length) {
    console.log(
      `[Slack] Buffer flush: skipping ${bufferedItems.length - items.length} already delivered message(s) in ${key}`,
    );
  }
  if (items.length === 0) return;
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
        userTeam: items[0]!.userTeam,
      })
    : (await findUserByExternalId("slack", originalRequesterId))?.id;

  // What steering is about to see: if this task is claimed while the thread is
  // read below, the messages steer it instead of becoming a second task.
  const leadTaskAtSteer = await getLatestLeadTaskInThread(channelId, threadTs);

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
      await slackFlush(items.slice(nextSenderIndex), key, immediate, foldAttempts);
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
      await slackFlush(items.slice(nextSenderIndex), key, immediate, foldAttempts);
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
    items
      .map((item, index) => formatAuthoredMessage(`<@${item.userId}>`, itemTexts[index]!))
      .join("\n---\n"),
    botUserId,
    snapshot?.trust,
  );
  const description = `${followUpHeader(items.length)}\n\n${labelledText}`;
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
  const createOptions: CreateTaskOptions = {
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
  };
  const slackEvent = {
    trigger: "thread-buffer" as const,
    messages: items.map(({ ts, userId, text }) => ({ ts, userId, text })),
  };

  // Lead has not started the thread's latest task yet: add the messages to it
  // instead of a second task that repeats the whole thread context.
  const foldTarget = foldAttempts > 0 ? await getLatestLeadTaskInThread(channelId, threadTs) : null;
  if (
    foldTarget &&
    foldTarget.id === leadTaskAtSteer?.id &&
    leadTaskAtSteer.status === "pending" &&
    foldTarget.status === "in_progress"
  ) {
    console.log(`[Slack] Task ${foldTarget.id} was claimed during the flush; retrying to steer it`);
    await slackFlush(items, key, immediate, foldAttempts - 1);
    return;
  }
  if (isFoldTarget(foldTarget, channelId, threadTs, lead?.id, immediate, newestRequesterId)) {
    // The messages must pass the same pre.task.create gate a new task would.
    const gate = await applyPreTaskCreate({
      description: fullDescription,
      options: createOptions,
      origin: "slack",
      slack: slackEvent,
    });
    if (gate.kind === "blocked") {
      console.info("[Slack] pre.task.create blocked:", gate.extension.name, gate.reason);
      if (app) await skipSlackMessageReaction(app.client, channelId, items.at(-1)!.ts);
      return;
    }
    // shortcut: a hook that rewrites the follow-up gets a task of its own; merge its edits into the fold if hooks start rewriting Slack follow-ups.
    if (
      gate.description === fullDescription &&
      JSON.stringify(gate.options) === JSON.stringify(createOptions)
    ) {
      const landed = await foldIntoPendingSlackTask({
        taskId: foldTarget.id,
        expectedTask: foldTarget.task,
        nextTask: appendFollowUpMessages(foldTarget.task, labelledText, items.length),
        toDraft: inbound.fetched.length > 0,
        slackChannelId: channelId,
        messageTs: items.map((item) => item.ts),
        slackParticipants: snapshot
          ? foldParticipants(foldTarget.slackParticipants, snapshot.participants)
          : undefined,
      });
      if (!landed) {
        // A worker claimed it (steer it now) or another flush changed it (fold again).
        console.log(`[Slack] Buffer fold lost the race for task ${foldTarget.id}; retrying flush`);
        await slackFlush(items, key, immediate, foldAttempts - 1);
        return;
      }
      const unattached =
        inbound.fetched.length > 0
          ? [...inbound.failed, ...(await attachSlackFilesToDraft(foldTarget.id, inbound))]
          : inbound.failed;
      console.log(
        `[Slack] Buffer flushed → folded ${items.length} message(s) into ${foldTarget.id}`,
      );
      await postFoldFeedback({
        channelId,
        threadTs,
        taskId: foldTarget.id,
        items,
        unattached,
        lead,
      });
      return;
    }
  }

  let created: Awaited<ReturnType<typeof createSlackTaskWithFiles>>;
  try {
    created = await createSlackTaskWithFiles(
      fullDescription,
      createOptions,
      inbound,
      slackEvent,
      // The trigger is the newest message; the task carries the rest too.
      items.slice(0, -1).map((item) => item.ts),
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
    await ensureSlackThreadPresentation([task.id]);
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
