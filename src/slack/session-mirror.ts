import type { WebClient } from "@slack/web-api";
import { claimKv, deleteKv, getTaskById } from "../be/db";
import { getSessionRoot } from "../be/session-shares";
import { findUserById, getUserIdentities } from "../be/users";
import type { AgentTask } from "../types";
import { getAppUrl } from "../utils/constants";
import { scrubSecrets } from "../utils/secret-scrubber";
import { workflowEventBus } from "../workflows/event-bus";
import { getSlackApp } from "./app";
import { getChannelExternality } from "./external-channel";
import { slackDelegationOwnsChildCard } from "./render-v2";
import { sendTaskResponse } from "./responses";

/**
 * Mirrors a Sessions follow-up into the Slack thread its session is bound to,
 * so the thread reads the same as the session: the person's message (their
 * name and Slack avatar, "Sent from Sessions") when the task is created, and
 * the outcome card when it ends. Only a task a person typed in the dashboard
 * qualifies; Slack-originated, agent and system tasks keep today's behaviour.
 *
 * `SLACK_SESSION_MIRROR` (read at call time): `both` (default) mirrors the
 * message and the reply, `reply` only the reply, `off` neither. Slack Connect
 * channels are skipped under every value, failing closed when Slack cannot
 * say whether a channel is shared.
 */

export type SessionMirrorMode = "off" | "reply" | "both";

export const SESSION_MIRROR_MODES: readonly SessionMirrorMode[] = ["off", "reply", "both"];

/** Durable once-only markers, so a re-emitted event never posts twice. */
const MIRROR_KV_NAMESPACE = "slack-session-mirror";
const MIRROR_KV_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Slack caps a section's text at 3,000 characters. */
const MAX_PROMPT_CHARS = 2_900;
const REPLY_EVENTS = ["task.completed", "task.failed", "task.cancelled"] as const;

export function sessionMirrorMode(): SessionMirrorMode {
  const raw = process.env.SLACK_SESSION_MIRROR?.trim().toLowerCase();
  return SESSION_MIRROR_MODES.includes(raw as SessionMirrorMode)
    ? (raw as SessionMirrorMode)
    : "both";
}

/** A dashboard task a person typed into a session bound to a Slack thread. */
function isPersonSessionFollowUp(task: AgentTask): boolean {
  return (
    task.source === "ui" &&
    !!task.parentTaskId &&
    !!task.requestedByUserId &&
    !task.creatorAgentId &&
    !!task.slackChannelId &&
    !!task.slackThreadTs
  );
}

function logFailure(what: string, taskId: string, error: unknown): void {
  console.warn(
    `[Slack] Session mirror ${what} failed for task ${taskId}:`,
    scrubSecrets(error instanceof Error ? error.message : String(error)),
  );
}

/** True only when Slack confirms the channel is internal to this organization. */
async function isInternalChannel(client: WebClient, channelId: string): Promise<boolean> {
  return (await getChannelExternality(client, channelId)) === "internal";
}

/** Claims the once-only marker; false when another call already holds it. */
function claimOnce(key: string): Promise<boolean> {
  return claimKv({
    namespace: MIRROR_KV_NAMESPACE,
    key,
    value: new Date().toISOString(),
    valueType: "string",
    expiresAt: Date.now() + MIRROR_KV_TTL_MS,
  });
}

/** Slack control characters, escaped so typed text cannot @-mention or link. */
function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The person's name and Slack avatar; the avatar needs a linked Slack identity. */
async function resolvePersona(
  client: WebClient,
  userId: string,
): Promise<{ username: string; icon_url?: string }> {
  const user = await findUserById(userId);
  const fallback = { username: user?.name ?? "Sessions" };
  const slackUserId = (await getUserIdentities(userId)).find(
    (id) => id.kind === "slack",
  )?.externalId;
  if (!slackUserId) return fallback;
  try {
    const info = await client.users.info({ user: slackUserId });
    const profile = info.user?.profile;
    const username =
      profile?.display_name?.trim() || profile?.real_name?.trim() || fallback.username;
    const icon = profile?.image_72 ?? profile?.image_48;
    return icon ? { username, icon_url: icon } : { username };
  } catch (error) {
    logFailure("avatar lookup", userId, error);
    return fallback;
  }
}

/** Builds the mirrored message. Exported for the e2e scenario's payload check. */
export function buildSessionPromptMessage(opts: { text: string; sessionUrl: string }) {
  const escaped = escapeSlackText(opts.text.trim());
  // shortcut: long prompts are cut at one section; split into sections if people paste essays.
  const body =
    escaped.length > MAX_PROMPT_CHARS ? `${escaped.slice(0, MAX_PROMPT_CHARS)}…` : escaped;
  return {
    text: body,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: body } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Sent from <${opts.sessionUrl}|Sessions>` }],
      },
    ],
  };
}

/**
 * Posts the person's follow-up into the session's Slack thread. Call it after
 * the task row commits. Never throws: a failed post leaves the task untouched.
 */
export async function mirrorSessionPrompt(task: AgentTask): Promise<void> {
  try {
    if (sessionMirrorMode() !== "both" || task.status === "draft") return;
    if (!isPersonSessionFollowUp(task)) return;
    const app = getSlackApp();
    if (!app) return;
    const channel = task.slackChannelId as string;
    if (!(await isInternalChannel(app.client, channel))) return;
    if (!(await claimOnce(`prompt:${task.id}`))) return;

    const root = await getSessionRoot(task.id);
    const sessionUrl = `${getAppUrl()}/sessions/${encodeURIComponent(root?.id ?? task.id)}`;
    const persona = await resolvePersona(app.client, task.requestedByUserId as string);
    try {
      await app.client.chat.postMessage({
        channel,
        thread_ts: task.slackThreadTs,
        ...buildSessionPromptMessage({ text: task.task, sessionUrl }),
        ...persona,
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (error) {
      await deleteKv(MIRROR_KV_NAMESPACE, `prompt:${task.id}`);
      throw error;
    }
  } catch (error) {
    logFailure("prompt", task.id, error);
  }
}

/**
 * Posts the outcome card of a person's Sessions follow-up, the card a
 * Slack-sourced task gets. Skipped when the agent already replied in the
 * thread (`slackReplySent`) or the delegation renderer posts the task's
 * child card, so the thread gets the answer once.
 */
export async function mirrorSessionReply(taskId: string): Promise<void> {
  try {
    if (sessionMirrorMode() === "off") return;
    const task = await getTaskById(taskId);
    if (!task || !isPersonSessionFollowUp(task) || task.slackReplySent) return;
    const app = getSlackApp();
    if (!app) return;
    if (await slackDelegationOwnsChildCard(task)) return;
    if (!(await isInternalChannel(app.client, task.slackChannelId as string))) return;
    if (!(await claimOnce(`reply:${task.id}`))) return;
    if (!(await sendTaskResponse(task))) {
      await deleteKv(MIRROR_KV_NAMESPACE, `reply:${task.id}`);
      logFailure("reply", task.id, "Slack did not accept the outcome card");
    }
  } catch (error) {
    logFailure("reply", taskId, error);
  }
}

// shortcut: event-driven, so a restart between the terminal commit and the post drops
// that one reply; move to a slack_relay_obligations-style row if that matters.
const onTerminal = (payload: unknown) => {
  const event = payload as { taskId?: unknown; previousStatus?: unknown } | null;
  // A draft that ends before promotion (withdrawn, or its uploads failed) was never sent.
  if (event?.previousStatus === "draft") return;
  if (typeof event?.taskId === "string") void mirrorSessionReply(event.taskId);
};

let subscribed = false;

export function startSessionReplyMirror(): void {
  if (subscribed) return;
  for (const event of REPLY_EVENTS) workflowEventBus.on(event, onTerminal);
  subscribed = true;
}

export function stopSessionReplyMirror(): void {
  if (!subscribed) return;
  for (const event of REPLY_EVENTS) workflowEventBus.off(event, onTerminal);
  subscribed = false;
}
