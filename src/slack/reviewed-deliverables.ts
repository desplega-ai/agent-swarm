import type { WebClient } from "@slack/web-api";
import { getAgentById, getTaskById } from "../be/db";
import type { AgentTask, TaskAttachment } from "../types";
import {
  getAgentFsLiveUrl,
  getAppUrl,
  getPublicMcpBaseUrl,
  isAgentFsProxyEnabled,
} from "../utils/constants";
import { taskAttachmentDisplayUrl } from "../utils/task-attachment-links";
import { getTaskUrl } from "./blocks";
import { getChannelExternality } from "./external-channel";
import { getSlackOutputAttachments } from "./task-attachments";

/** Most links one card lists; the rest are counted under "+N more". */
const MAX_DELIVERABLE_LINKS = 6;
const MAX_LINK_LABEL_LENGTH = 40;
const OUTPUT_URL_PATTERN = /https?:\/\/[^\s<>()[\]{}"'`|]+/g;
// An agent-fs public share page (`/share/<token>`) or shared folder site
// (`/site/<token>/`), on the agent-fs host or the API's proxy of it.
const PUBLIC_SHARE_PATH = /^\/(?:share|site)\/[^/]+/;

const VIDEO_EXTENSION = /\.(?:mp4|mov|webm|m4v|mkv)$/i;
const VIDEO_HOSTS = new Set(["youtube.com", "youtu.be", "loom.com", "vimeo.com"]);
// A GitHub PR or issue: `owner/repo`, `pull` or `issues`, the number. A tab
// (`/files`) or an anchor (`#pullrequestreview-…`) is still that PR.
const GITHUB_ITEM_PATH = /^\/([^/]+\/[^/]+)\/(pull|issues)\/(\d+)(?=\/|$)/;

/** `icon` is a Unicode emoji, which Slack renders in mrkdwn. */
export type DeliverableLink = { url: string; label: string; icon: string };

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

function truncate(label: string): string {
  return label.length <= MAX_LINK_LABEL_LENGTH
    ? label
    : `${label.slice(0, MAX_LINK_LABEL_LENGTH - 1)}…`;
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** `host/last-segment`, with `…` for the segments between. */
function shortUrlLabel(parsed: URL): string {
  const host = parsed.hostname.replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter(Boolean).map(decoded);
  if (segments.length === 0) return host;
  return `${host}/${segments.length > 1 ? "…/" : ""}${segments.at(-1)}`;
}

/**
 * A short label and a type icon for a deliverable: an attachment keeps its
 * own name, a bare link gets one from its URL (a file name, `Page`). A GitHub
 * PR or issue is always `PR #12` / `Issue #12`.
 */
export function describeLink(
  url: string,
  attachment?: TaskAttachment,
): Omit<DeliverableLink, "url"> {
  const name = attachment?.name.replace(/\s+/g, " ").trim();
  const labelled = (icon: string, fallback: string) => ({
    icon,
    label: truncate(name || fallback),
  });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return labelled("🔗", url);
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const path = parsed.pathname;
  const fileName = decoded(path.split("/").filter(Boolean).at(-1) ?? "") || shortUrlLabel(parsed);
  const github = host === "github.com" ? path.match(GITHUB_ITEM_PATH) : null;
  // The server names its own PR attachments "GitHub pull request #N": always use the short form.
  if (github) {
    const pull = github[2] === "pull";
    const anchor = parsed.hash.startsWith("#pullrequestreview-")
      ? " review"
      : /^#(?:discussion_r|issuecomment-)/.test(parsed.hash)
        ? " comment"
        : "";
    return { icon: pull ? "🔀" : "🎫", label: `${pull ? "PR" : "Issue"} #${github[3]}${anchor}` };
  }
  if (attachment?.mimeType?.startsWith("video/") || VIDEO_EXTENSION.test(path)) {
    return labelled("🎬", fileName);
  }
  if (VIDEO_HOSTS.has(host)) return labelled("🎬", "Video");
  if (isPublicShareUrl(url)) {
    return labelled("🔗", path.startsWith("/site/") ? "Shared site" : "Shared file");
  }
  const appPage = parsed.origin === urlOrigin(getAppUrl()) && /^\/pages\/[^/]+\/?$/.test(path);
  if (attachment?.kind === "page" || appPage) return labelled("📃", "Page");
  if (
    attachment?.kind === "agent-fs" ||
    attachment?.kind === "shared-fs" ||
    attachment?.providerId === "agent-fs" ||
    path.includes("/file/~/")
  ) {
    return labelled("📄", fileName);
  }
  return labelled("🌐", shortUrlLabel(parsed));
}

/**
 * A URL compared by target: `www.`, host case and trailing slashes do not
 * count, and every link into one GitHub PR or issue (a review, a comment, the
 * files tab) is that PR.
 */
export function linkKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.replace(/^www\./, "");
    const github = parsed.hostname === "github.com" && parsed.pathname.match(GITHUB_ITEM_PATH);
    if (github) return `https://github.com/${github[1]}/${github[2]}/${github[3]}`;
    return parsed.href.replace(/\/+(?=$|[?#])/, "");
  } catch {
    return url.replace(/\/+$/, "");
  }
}

/** A Slack `<url|label>` link: the label is escaped, the destination keeps its own escapes. */
export function slackLink(url: string, name: string): string {
  const label = name
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<${url.replace(/[\s\\<>|]/g, encodeURIComponent)}|${label}>`;
}

// Escapes, code, and text that is already a link come first, so a URL inside
// them is never matched on its own. Group 2 is a bare URL.
const LINKIFY_PATTERN = new RegExp(
  [
    String.raw`\\[\s\S]`,
    "```[\\s\\S]*?(?:```|$)",
    "~~~[\\s\\S]*?(?:~~~|$)",
    String.raw`(?<!\`)(\`+)(?!\`)(?:(?!\r?\n[ \t]*\r?\n)[\s\S])*?(?<!\`)\1(?!\`)`,
    String.raw`<https?:\/\/[^<>\s]*(?:\|[^<>\n]*)?>`,
    String.raw`!?\[[^\]]*\]\([^)\s]*(?:\s+"[^"]*")?\)`,
    `(${OUTPUT_URL_PATTERN.source})`,
  ].join("|"),
  "g",
);

// The words a writer puts before a PR or issue URL: "PR <url>" reads "PR #12".
const ITEM_KIND_BEFORE = /\b(?:PR|pull request|issue)\s+$/i;

/**
 * Bare http(s) URLs in Markdown as Slack `<url|label>` links, labelled like
 * the "Links:" caption. A PR or issue URL right after "PR" or "issue" is
 * labelled `#12`, so the text never reads "PR PR #12". Code, `<url|label>`
 * and `[label](url)` stay as written.
 */
export function linkifyBareUrls(text: string): string {
  return text.replace(
    LINKIFY_PATTERN,
    (match, _code, url: string | undefined, offset: number, whole: string) => {
      // A URL that runs on into a bracket (a `[REDACTED]` marker, a query in
      // braces) has no known end: leave it bare rather than link half of it.
      if (!url || /[[({<`]/.test(whole[offset + match.length] ?? "")) return match;
      const href = url.replace(/[.,;:!?*_~]+$/, "");
      const { label } = describeLink(href);
      const kindless = label.match(/^(?:PR|Issue) (#\d+.*)$/)?.[1];
      const shown =
        kindless && ITEM_KIND_BEFORE.test(whole.slice(Math.max(0, offset - 32), offset))
          ? kindless
          : label;
      return `${slackLink(href, shown)}${url.slice(href.length)}`;
    },
  );
}

/**
 * The deliverables of the worker task a Lead follow-up reviews: its output
 * attachments, then the http(s) links in its output. Worker cards do not post
 * while delegation is off, so the follow-up card is the only place a person
 * sees them. Links in `seen` (the card's answer, sources and own
 * attachment) are skipped. In a channel Slack does not confirm as internal (Slack
 * Connect, or a failed lookup), only public share links the worker already
 * made are kept: an app or agent-fs file link needs a login the other
 * organization does not have, and would disclose an internal path.
 */
export async function reviewedTaskDeliverables(
  task: AgentTask,
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
    candidates.push({ url, ...describeLink(url, attachment) });
  }
  for (const url of outputLinks(reviewed.output ?? "")) {
    candidates.push({ url, ...describeLink(url) });
  }
  if (candidates.length === 0) return none;

  const internal =
    !!client && (await getChannelExternality(client, task.slackChannelId)) === "internal";
  const skip = new Set(seen.map(linkKey));
  const links: DeliverableLink[] = [];
  for (const candidate of candidates) {
    const key = linkKey(candidate.url);
    if (!/^https?:\/\//.test(candidate.url) || skip.has(key)) continue;
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
