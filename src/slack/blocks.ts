/**
 * Block Kit message builders for structured Slack messages.
 *
 * Consolidates getTaskLink and markdownToSlack (previously duplicated
 * across responses.ts, handlers.ts, thread-buffer.ts).
 */

import type { AgentTaskStatus, TaskAttachment } from "../types";
import { getAppUrl } from "../utils/constants";
import { taskAttachmentDisplayUrl } from "../utils/task-attachment-links";

// Slack limits section text to 3000 chars; we use 2900 for safety.
export const MAX_SECTION_LENGTH = 2900;
export const MAX_BLOCKS_PER_COMPLETION_MESSAGE = 45;

// biome-ignore lint/suspicious/noExplicitAny: Slack block types are complex unions; we build plain objects
type SlackBlock = any;

// --- Shared utilities ---

/**
 * Get a Slack-formatted clickable link to the task in the dashboard.
 * Always returns Slack mrkdwn link syntax (`<url|label>`) so partial task
 * IDs are clickable in every message — falls back to the public dashboard
 * when APP_URL is not configured.
 */
export function getTaskLink(taskId: string): string {
  const shortId = taskId.slice(0, 8);
  return `<${getTaskUrl(taskId)}|\`${shortId}\`>`;
}

/**
 * Get a raw dashboard URL for a task (for link buttons).
 */
export function getTaskUrl(taskId: string): string {
  return `${getAppUrl()}/tasks/${taskId}`;
}

/**
 * Convert GitHub-flavored markdown to Slack mrkdwn format.
 *
 * Key differences:
 * - GitHub: **bold**, __bold__, *italic*, ~~strike~~, ### Header, [text](url)
 * - Slack:  *bold*,  *bold*,   _italic_, ~strike~,   *Header*, text (url)
 */
export function markdownToSlack(text: string): string {
  return (
    text
      // Images: keep alt text and expose the URL plainly.
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt, url) =>
        alt ? `${alt} (${url})` : url,
      )
      // Links: keep a plain URL fallback instead of Slack's <url|text> shortcut.
      // Slack block auto-promotion has historically rejected that shortcut with
      // invalid_blocks, while plain URLs remain copyable and auto-unfurlable.
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "$1 ($2)")
      // Headers to bold placeholder (# Header -> bold, protected from italic)
      .replace(/^#{1,6}\s+(.+)$/gm, "\uE000$1\uE001")
      // Bold **text** -> placeholder (to avoid italic chain converting *bold* to _italic_)
      .replace(/\*\*(.+?)\*\*/g, "\uE000$1\uE001")
      // Bold __text__ -> placeholder
      .replace(/__(.+?)__/g, "\uE000$1\uE001")
      // Italic *text* -> _text_ (single asterisks, now safe from bold placeholders)
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "_$1_")
      // Italic _text_ already matches Slack mrkdwn; leave it alone.
      // Restore bold from placeholder -> *text*
      .replace(/\uE000(.+?)\uE001/g, "*$1*")
      // Strikethrough ~~text~~ -> ~text~
      .replace(/~~(.+?)~~/g, "~$1~")
      // Inline code already works the same
      // Bullet points already work the same
      // Remove excessive blank lines
      .replace(/\n{3,}/g, "\n\n")
  );
}

/**
 * Split text into chunks that fit within Slack's section text limit.
 */
export function splitSlackSectionText(text: string): string[] {
  if (text.length <= MAX_SECTION_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_SECTION_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", MAX_SECTION_LENGTH);
    if (splitIdx < MAX_SECTION_LENGTH / 2) {
      // No good newline break, try splitting at space
      splitIdx = remaining.lastIndexOf(" ", MAX_SECTION_LENGTH);
    }
    if (splitIdx < MAX_SECTION_LENGTH / 2) {
      // No good break point at all, hard split
      splitIdx = MAX_SECTION_LENGTH;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

// --- Block primitives ---

function contextBlock(...elements: string[]): SlackBlock {
  return {
    type: "context",
    elements: elements.map((text) => ({ type: "mrkdwn", text })),
  };
}

function sectionBlock(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function cancelActionBlock(taskId: string): SlackBlock {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Cancel" },
        action_id: "cancel_task",
        value: taskId,
        style: "danger",
        confirm: {
          title: { type: "plain_text", text: "Cancel task?" },
          text: { type: "mrkdwn", text: "This will cancel the task. Are you sure?" },
          confirm: { type: "plain_text", text: "Yes, cancel" },
          deny: { type: "plain_text", text: "Never mind" },
        },
      },
    ],
  };
}

// --- Utilities ---

// Mirrors the `store-progress` input cap so a misbehaving agent can't fill
// the Slack card with hundreds of lines.
const SLACK_ATTACHMENTS_MAX = 20;

/**
 * Resolve an attachment to a Slack-friendly display string — a plain URL
 * when one can be derived, otherwise a `<kind>:<pointer>` fallback. We use
 * *plain* URLs (no `<URL|text>` mrkdwn shortcut) because Slack auto-unfurls
 * them and the shortcut form has historically triggered `invalid_blocks`.
 *
 * `agent-fs` attachments emit a public live-host URL when the row carries
 * `orgId` and `driveId` (or when the operator-set
 * `AGENT_FS_DEFAULT_ORG_ID` / `AGENT_FS_DEFAULT_DRIVE_ID` env-vars provide
 * a fallback). Without either, we keep the `agent-fs:<path>` raw fallback so
 * the link is at least copy-pasteable.
 */
function resolveAttachmentDisplay(a: TaskAttachment): string {
  return taskAttachmentDisplayUrl(a);
}

/**
 * Build a compact "Attachments (N):" block in Slack mrkdwn for the completion
 * card. Returns empty string when there are no attachments so callers can
 * blindly concat without worrying about a stray label.
 *
 * Per-line format: `• <name> — _<intent>_ — <plain URL>` where the italic
 * descriptor falls back to `description` and is omitted when both are empty.
 */
export function formatAttachmentsBlockForSlack(attachments: TaskAttachment[]): string {
  if (attachments.length === 0) return "";
  const capped = attachments.slice(0, SLACK_ATTACHMENTS_MAX);
  const lines = capped.map((a) => {
    const descriptor = a.intent || a.description;
    const middle = descriptor ? ` — _${descriptor}_` : "";
    const display = resolveAttachmentDisplay(a);
    const tail = display ? ` — ${display}` : "";
    return `• *${a.name}*${middle}${tail}`;
  });
  return `\n\n*Attachments (${attachments.length}):*\n${lines.join("\n")}`;
}

/**
 * Format a duration between two dates in a compact human-readable form.
 * Examples: "45s", "2m 14s", "1h 30m"
 */
export function formatDuration(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

// --- Tree types ---

export interface TreeNode {
  taskId: string;
  agentName: string;
  status: AgentTaskStatus;
  progress?: string;
  duration?: string;
  slackReplySent?: boolean;
  output?: string; // Only used when !slackReplySent on completion
  failureReason?: string; // Always shown on failure
  /**
   * Pointer-based attachments to surface on the tree-message render. The
   * watcher populates this for completed/terminal nodes so links survive on
   * the tree path (`buildTreeBlocks`) — not just the DM completion card
   * (`buildCompletedBlocks` / `responses.ts`). Optional so unit tests and
   * non-attachment paths stay terse.
   */
  attachments?: TaskAttachment[];
  children: TreeNode[];
}

// --- High-level block builders ---

/**
 * Build blocks for a completed task response.
 * Single-line header with agent/task metadata, then body content.
 */
export function buildCompletedBlocks(opts: {
  agentName: string;
  taskId: string;
  body: string;
  duration?: string;
  minimal?: boolean; // true = suppress body (agent already replied via slack-reply)
  /**
   * Optional trailer rendered even when `minimal` is true. Used for the
   * attachments block so links survive on the compact completion card.
   */
  trailer?: string;
}): SlackBlock[] {
  const taskLink = getTaskLink(opts.taskId);
  let line = `✅ *${opts.agentName}* (${taskLink})`;
  if (opts.duration) line += ` · ${opts.duration}`;

  const blocks: SlackBlock[] = [sectionBlock(line)];

  // Only include body if not minimal (agent didn't reply via slack-reply)
  if (!opts.minimal) {
    for (const chunk of splitSlackSectionText(opts.body)) {
      blocks.push(sectionBlock(chunk));
    }
  } else if (opts.trailer && opts.trailer.length > 0) {
    for (const chunk of splitSlackSectionText(opts.trailer)) {
      blocks.push(sectionBlock(chunk));
    }
  }
  return blocks;
}

/**
 * Build one or more completed-task block payloads. The first payload carries
 * the normal completion header; continuation payloads carry a compact part
 * header. This keeps long completion summaries inside Slack's block limits
 * without dropping body text.
 */
export function buildCompletedBlockBatches(opts: Parameters<typeof buildCompletedBlocks>[0]) {
  const allBlocks = buildCompletedBlocks(opts);
  if (allBlocks.length <= MAX_BLOCKS_PER_COMPLETION_MESSAGE) return [allBlocks];

  const header = allBlocks[0];
  const bodyBlocks = allBlocks.slice(1);
  const bodyLimit = MAX_BLOCKS_PER_COMPLETION_MESSAGE - 1;
  const batches: SlackBlock[][] = [];

  for (let start = 0; start < bodyBlocks.length; start += bodyLimit) {
    const partBlocks = bodyBlocks.slice(start, start + bodyLimit);
    if (start === 0) {
      batches.push([header, ...partBlocks]);
    } else {
      const part = batches.length + 1;
      batches.push([
        sectionBlock(
          `↳ *${opts.agentName}* (${getTaskLink(opts.taskId)}) continued · part ${part}`,
        ),
        ...partBlocks,
      ]);
    }
  }

  return batches;
}

/**
 * Build blocks for a failed task response.
 * Single-line header, then error in code block.
 */
export function buildFailedBlocks(opts: {
  agentName: string;
  taskId: string;
  reason: string;
  duration?: string;
}): SlackBlock[] {
  const taskLink = getTaskLink(opts.taskId);
  let line = `❌ *${opts.agentName}* (${taskLink})`;
  if (opts.duration) line += ` · ${opts.duration}`;

  return [sectionBlock(line), sectionBlock(`\`\`\`${opts.reason}\`\`\``)];
}

/**
 * Build blocks for a progress update.
 * Single line with cancel button.
 */
export function buildProgressBlocks(opts: {
  agentName: string;
  taskId: string;
  progress: string;
}): SlackBlock[] {
  const taskLink = getTaskLink(opts.taskId);
  return [
    sectionBlock(`*${opts.agentName}* (${taskLink}): ${opts.progress}`),
    cancelActionBlock(opts.taskId),
  ];
}

/**
 * Build blocks for a cancelled task card (used when cancel button is clicked).
 */
export function buildCancelledBlocks(opts: { agentName: string; taskId: string }): SlackBlock[] {
  const taskLink = getTaskLink(opts.taskId);
  return [sectionBlock(`🚫 *${opts.agentName}* (${taskLink}) — Cancelled`)];
}

/**
 * Build blocks for a consolidated task assignment summary.
 * Each assignment/queue/failure is a single line.
 */
export function buildAssignmentSummaryBlocks(results: {
  assigned: Array<{ agentName: string; taskId: string }>;
  queued: Array<{ agentName: string; taskId: string }>;
  failed: Array<{ agentName: string; reason: string }>;
}): SlackBlock[] {
  const lines: string[] = [];

  for (const a of results.assigned) {
    lines.push(`📡 Task assigned to: *${a.agentName}* (${getTaskLink(a.taskId)})`);
  }
  for (const q of results.queued) {
    lines.push(`📡 Task queued for: *${q.agentName}* (${getTaskLink(q.taskId)})`);
  }
  for (const f of results.failed) {
    lines.push(`⚠️ Could not assign to: *${f.agentName}* — ${f.reason}`);
  }

  return [sectionBlock(lines.join("\n"))];
}

/**
 * Build blocks for buffer flush feedback.
 */
export function buildBufferFlushBlocks(opts: {
  messageCount: number;
  taskId: string;
  hasDependency: boolean;
}): SlackBlock[] {
  const taskLink = getTaskLink(opts.taskId);
  const text = opts.hasDependency
    ? `${opts.messageCount} follow-up message(s) queued pending completion of current task`
    : `${opts.messageCount} follow-up message(s) batched into task`;

  return [contextBlock(`📡 _${text}_ (${taskLink})`)];
}

// --- Tree rendering ---

type TreeStatusIcon = TreeNode["status"] | "superseded";

const STATUS_ICON: Record<TreeStatusIcon, string> = {
  backlog: "🗂️",
  unassigned: "📭",
  offered: "📨",
  reviewing: "👀",
  pending: "📡",
  in_progress: "⏳",
  paused: "⏸️",
  completed: "✅",
  failed: "❌",
  cancelled: "🚫",
  superseded: "↪️",
};

const MAX_VISIBLE_CHILDREN = 8;
const MAX_OUTPUT_LENGTH = 120;

/**
 * Truncate output to the first sentence or MAX_OUTPUT_LENGTH, whichever is shorter.
 */
function truncateOutput(text: string): string {
  // Find first sentence boundary (. followed by space or end)
  const sentenceEnd = text.search(/\.\s/);
  const firstSentence = sentenceEnd !== -1 ? text.slice(0, sentenceEnd + 1) : text;
  if (firstSentence.length <= MAX_OUTPUT_LENGTH) return firstSentence;
  const boundary = text.lastIndexOf(" ", MAX_OUTPUT_LENGTH);
  const cut = boundary >= MAX_OUTPUT_LENGTH / 2 ? boundary : MAX_OUTPUT_LENGTH;
  const omitted = text.length - cut;
  return `${text.slice(0, cut).trimEnd()}… (${omitted} more chars; full output in thread)`;
}

/**
 * Render a single node line: icon + bold name + task link + optional duration.
 */
function renderNodeLine(node: TreeNode): string {
  const icon = STATUS_ICON[node.status] ?? "•";
  const taskLink = getTaskLink(node.taskId);
  let line = `${icon} *${node.agentName}* (${taskLink})`;
  if (node.duration) line += ` · ${node.duration}`;
  return line;
}

/**
 * Render detail lines for a child node (progress, output, failure reason).
 * Returns an array of indented lines to appear below the child's main line.
 */
function renderChildDetail(node: TreeNode, indent: string): string[] {
  const lines: string[] = [];

  if (node.status === "failed" && node.failureReason) {
    lines.push(`${indent}Error: ${node.failureReason}`);
  }

  if (node.status === "in_progress" && node.progress) {
    lines.push(`${indent}${node.progress}`);
  }

  if (node.status === "completed" && !node.slackReplySent && node.output) {
    lines.push(`${indent}${truncateOutput(markdownToSlack(node.output))}`);
  }

  return lines;
}

/**
 * Render a single root node and its children as a mrkdwn tree string.
 */
function renderTree(root: TreeNode): string {
  const lines: string[] = [];

  // Root line
  lines.push(renderNodeLine(root));

  // Root-level detail (progress for in-progress root with no children)
  if (root.children.length === 0) {
    if (root.status === "in_progress" && root.progress) {
      lines.push(`    ${root.progress}`);
    }
    if (root.status === "failed" && root.failureReason) {
      lines.push(`    Error: ${root.failureReason}`);
    }
    if (root.status === "completed" && !root.slackReplySent && root.output) {
      lines.push(`    ${truncateOutput(markdownToSlack(root.output))}`);
    }
    return lines.join("\n");
  }

  const visibleChildren = root.children.slice(0, MAX_VISIBLE_CHILDREN);
  const hiddenCount = root.children.length - visibleChildren.length;

  const prefix = "↳ ";
  const continuationPrefix = "   ";

  for (const child of visibleChildren) {
    lines.push(`${prefix}${renderNodeLine(child)}`);

    for (const detail of renderChildDetail(child, continuationPrefix)) {
      lines.push(detail);
    }
  }

  if (hiddenCount > 0) {
    lines.push(`↳ _and ${hiddenCount} more..._`);
  }

  return lines.join("\n");
}

/**
 * Check if any node in the tree is still active (pending or in_progress).
 */
function isTreeActive(node: TreeNode): boolean {
  if (node.status === "pending" || node.status === "in_progress") return true;
  return node.children.some(isTreeActive);
}

// Cap on completed-task attachment blocks rendered per tree-message. Slack's
// API enforces 50-block / 40KB ceilings; the existing tree section + cancel
// buttons already consume a few blocks, and each attachment block can carry
// up to SLACK_ATTACHMENTS_MAX (=20) lines. 10 keeps us well inside both
// limits even on wide trees while preserving the most-recent completions.
const SLACK_TREE_ATTACHMENT_BLOCKS_MAX = 10;

/**
 * Flatten a tree (in render order: root first, then children) and collect
 * every completed node whose `attachments` array is non-empty. The tree
 * walks roots → children, mirroring `renderTree` so the attachment ordering
 * matches what the reader sees in the main tree section.
 */
function collectAttachmentNodes(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const root of roots) {
    const stack: TreeNode[] = [root];
    while (stack.length > 0) {
      const node = stack.shift() as TreeNode;
      if (node.status === "completed" && node.attachments && node.attachments.length > 0) {
        out.push(node);
      }
      for (const child of node.children) stack.push(child);
    }
  }
  return out;
}

/**
 * Build Slack blocks for a tree-based status message.
 *
 * Renders one or more root nodes as mrkdwn trees with status icons,
 * agent names, task links, durations, progress text, and error details.
 *
 * For in-progress trees, includes a cancel button per active root.
 *
 * Completed nodes that carry `attachments` (populated by the watcher from
 * `task_attachments`) emit one extra section block per node listing the
 * pointer-based artifacts. Capped at {@link SLACK_TREE_ATTACHMENT_BLOCKS_MAX}
 * per tree-message; overflow becomes a `… and M more …` context footer.
 *
 * @param roots - Array of root TreeNode objects (one per assigned task in a round)
 * @returns SlackBlock[] suitable for chat.postMessage / chat.update
 */
export function buildTreeBlocks(roots: TreeNode[]): SlackBlock[] {
  console.log(
    `[Slack] Building tree blocks for ${roots.length} root(s): ${roots.map((r) => r.taskId.slice(0, 8)).join(", ")}`,
  );

  const treeTexts = roots.map(renderTree);
  const blocks: SlackBlock[] = [sectionBlock(treeTexts.join("\n\n"))];

  // Attachment blocks for completed nodes, with per-tree-message cap.
  const attachmentNodes = collectAttachmentNodes(roots);
  const visibleAttachmentNodes = attachmentNodes.slice(0, SLACK_TREE_ATTACHMENT_BLOCKS_MAX);
  for (const node of visibleAttachmentNodes) {
    const body = formatAttachmentsBlockForSlack(node.attachments ?? []);
    if (!body) continue;
    // `formatAttachmentsBlockForSlack` returns a string starting with two
    // newlines so it can be appended directly to a completion body. In tree
    // mode we render the block on its own, prefixed by a header that ties
    // the attachments back to the right child node.
    const header = `*${node.agentName}* (${getTaskLink(node.taskId)})`;
    blocks.push(sectionBlock(`${header}${body}`));
  }
  const hiddenAttachmentNodes = attachmentNodes.length - visibleAttachmentNodes.length;
  if (hiddenAttachmentNodes > 0) {
    blocks.push(
      contextBlock(
        `_… and ${hiddenAttachmentNodes} more completed task${
          hiddenAttachmentNodes === 1 ? "" : "s"
        } with attachments_`,
      ),
    );
  }

  // Add cancel buttons for active roots
  for (const root of roots) {
    if (isTreeActive(root)) {
      blocks.push(cancelActionBlock(root.taskId));
    }
  }

  return blocks;
}
