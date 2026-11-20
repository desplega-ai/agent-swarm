import type { WebClient } from "@slack/web-api";
import { getAgentById, getTaskById } from "../be/db";
import type { AgentTask } from "../types";
import { getAgentFsLiveUrl, getPublicMcpBaseUrl, isAgentFsProxyEnabled } from "../utils/constants";
import { taskAttachmentDisplayUrl } from "../utils/task-attachment-links";
import { getTaskUrl } from "./blocks";
import { getChannelExternality } from "./external-channel";
import { getSlackOutputAttachments } from "./task-attachments";

/** Most links one card lists; the rest are counted under "+N more". */
const MAX_DELIVERABLE_LINKS = 6;
const MAX_LINK_LABEL_LENGTH = 60;
const OUTPUT_URL_PATTERN = /https?:\/\/[^\s<>()[\]{}"'`|]+/g;
// An agent-fs public share page (`/share/<token>`) or shared folder site
// (`/site/<token>/`), on the agent-fs host or the API's proxy of it.
const PUBLIC_SHARE_PATH = /^\/(?:share|site)\/[^/]+/;

export type DeliverableLink = { url: string; label: string };

function urlOrigin(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return undefined;
  }
}

/**
 * The origins that serve agent-fs public shares: the live host, the public
 * agent-fs API when set, and the API itself when it proxies `/share` and
 * `/site`. Read per call, so a config change applies without a restart.
 */
function publicShareOrigins(): Set<string> {
  const origins = [getAgentFsLiveUrl(), process.env.AGENT_FS_PUBLIC_URL];
  if (isAgentFsProxyEnabled()) origins.push(getPublicMcpBaseUrl());
  return new Set(origins.map(urlOrigin).filter((origin): origin is string => !!origin));
}

/**
 * True for an agent-fs public share link: anyone with it can open it without
 * a login. Both the origin and the path must match: worker output is free
 * text, so a `/share/` path on any other host proves nothing.
 */
export function isPublicShareUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return publicShareOrigins().has(parsed.origin) && PUBLIC_SHARE_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** The http(s) links in free text, without the punctuation that ends a sentence. */
export function outputLinks(text: string): string[] {
  return [...text.matchAll(OUTPUT_URL_PATTERN)].map((match) =>
    match[0].replace(/[.,;:!?*_~]+$/, ""),
  );
}

function linkLabel(url: string): string {
  const bare = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return bare.length <= MAX_LINK_LABEL_LENGTH
    ? bare
    : `${bare.slice(0, MAX_LINK_LABEL_LENGTH - 1)}…`;
}

function linkKey(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The deliverables of the worker task a Lead follow-up reviews: its output
 * attachments, then the http(s) links in its output. Worker cards do not post
 * while delegation is off, so the follow-up card is the only place a person
 * sees them. Links already in the Lead's answer (`leadText`) or in `seen`
 * are skipped. In a channel Slack does not confirm as internal (Slack
 * Connect, or a failed lookup), only public share links the worker already
 * made are kept: an app or agent-fs file link needs a login the other
 * organization does not have, and would disclose an internal path.
 */
export async function reviewedTaskDeliverables(
  task: AgentTask,
  leadText: string,
  seen: readonly string[],
  client: WebClient | undefined,
): Promise<{ links: DeliverableLink[]; omitted: number; moreUrl?: string }> {
  const none = { links: [], omitted: 0 };
  if (
    task.source !== "system" ||
    task.taskType !== "follow-up" ||
    !task.parentTaskId ||
    !task.slackChannelId ||
    !task.agentId ||
    !(await getAgentById(task.agentId))?.isLead
  ) {
    return none;
  }
  const reviewed = await getTaskById(task.parentTaskId);
  if (!reviewed) return none;

  const candidates: DeliverableLink[] = [];
  for (const attachment of await getSlackOutputAttachments(reviewed.id)) {
    const url = taskAttachmentDisplayUrl(attachment);
    const label = attachment.name.replace(/\s+/g, " ").trim() || linkLabel(url);
    candidates.push({ url, label });
  }
  for (const url of outputLinks(reviewed.output ?? "")) {
    candidates.push({ url, label: linkLabel(url) });
  }
  if (candidates.length === 0) return none;

  const internal =
    !!client && (await getChannelExternality(client, task.slackChannelId)) === "internal";
  const skip = new Set(seen.map(linkKey));
  const links: DeliverableLink[] = [];
  for (const candidate of candidates) {
    const key = linkKey(candidate.url);
    if (!/^https?:\/\//.test(candidate.url) || skip.has(key) || leadText.includes(key)) continue;
    if (!internal && !isPublicShareUrl(candidate.url)) continue;
    skip.add(key);
    links.push(candidate);
  }
  return {
    links: links.slice(0, MAX_DELIVERABLE_LINKS),
    omitted: Math.max(0, links.length - MAX_DELIVERABLE_LINKS),
    // The task page needs a swarm login: only an internal channel links to it.
    moreUrl: internal ? getTaskUrl(reviewed.id) : undefined,
  };
}
