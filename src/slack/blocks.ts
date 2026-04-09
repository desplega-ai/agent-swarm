/**
 * Block Kit message builders for structured Slack messages.
 *
 * Consolidates getTaskLink and markdownToSlack (previously duplicated
 * across responses.ts, handlers.ts, thread-buffer.ts).
 */

const appUrl = process.env.APP_URL || "";

// Slack limits section text to 3000 chars; we use 2900 for safety
const MAX_SECTION_LENGTH = 2900;

// biome-ignore lint/suspicious/noExplicitAny: Slack block types are complex unions; we build plain objects
type SlackBlock = any;

// --- Shared utilities ---

/**
 * Get a Slack-formatted link to the task in the dashboard, or just the short ID.
 */
export function getTaskLink(taskId: string): string {
  const shortId = taskId.slice(0, 8);
  if (appUrl) {
    return `<${appUrl}?tab=tasks&task=${taskId}&expand=true|\`${shortId}\`>`;
  }
  return `\`${shortId}\``;
}

/**
 * Get a raw dashboard URL for a task (for link buttons).
 */
export function getTaskUrl(taskId: string): string {
  if (appUrl) {
    return `${appUrl}?tab=tasks&task=${taskId}&expand=true`;
  }
  return "";
}

/**
 * Convert GitHub-flavored markdown to Slack mrkdwn format.
 *
 * Key differences:
 * - GitHub: **bold**, *italic*, ~~strike~~, [text](url)
 * - Slack:  *bold*,  _italic_, ~strike~,   <url|text>
 */
export function markdownToSlack(text: string): string {
  return (
    text
      // Headers to bold placeholder (# Header -> bold, protected from italic)
      .replace(/^#{1,6}\s+(.+)$/gm, "\uE000$1\uE001")
      // Bold **text** -> placeholder (to avoid italic chain converting *bold* to _italic_)
      .replace(/\*\*(.+?)\*\*/g, "\uE000$1\uE001")
      // Italic *text* -> _text_ (single asterisks, now safe from bold placeholders)
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "_$1_")
      // Restore bold from placeholder -> *text*
      .replace(/\uE000(.+?)\uE001/g, "*$1*")
      // Strikethrough ~~text~~ -> ~text~
      .replace(/~~(.+?)~~/g, "~$1~")
      // Links [text](url) -> <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
      // Inline code already works the same
      // Bullet points already work the same
      // Remove excessive blank lines
      .replace(/\n{3,}/g, "\n\n")
  );
}

/**
 * Split text into chunks that fit within Slack's section text limit.
 */
function splitText(text: string): string[] {
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
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  progress?: string;
  duration?: string;
  slackReplySent?: boolean;
  output?: string; // Only used when !slackReplySent on completion
  failureReason?: string; // Always shown on failure
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
}): SlackBlock[] {
  const taskLink = getTaskLink(opts.taskId);
  let line = `✅ *${opts.agentName}* (${taskLink})`;
  if (opts.duration) line += ` · ${opts.duration}`;

  const blocks: SlackBlock[] = [sectionBlock(line)];

  // Only include body if not minimal (agent didn't reply via slack-reply)
  if (!opts.minimal) {
    for (const chunk of splitText(opts.body)) {
      blocks.push(sectionBlock(chunk));
    }
  }
  return blocks;
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
  const shortId = opts.taskId.slice(0, 8);
  return [
    sectionBlock(`*${opts.agentName}* (\`${shortId}\`): ${opts.progress}`),
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

const STATUS_ICON: Record<TreeNode["status"], string> = {
  pending: "📡",
  in_progress: "⏳",
  completed: "✅",
  failed: "❌",
  cancelled: "🚫",
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
  return `${text.slice(0, MAX_OUTPUT_LENGTH)}…`;
}

/**
 * Render a single node line: icon + bold name + task link + optional duration.
 */
function renderNodeLine(node: TreeNode): string {
  const icon = STATUS_ICON[node.status];
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
    lines.push(`${indent}${truncateOutput(node.output)}`);
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
      lines.push(`    ${truncateOutput(root.output)}`);
    }
    return lines.join("\n");
  }

  const visibleChildren = root.children.slice(0, MAX_VISIBLE_CHILDREN);
  const hiddenCount = root.children.length - visibleChildren.length;

  for (let i = 0; i < visibleChildren.length; i++) {
    const child = visibleChildren[i] as TreeNode;
    const isLast = i === visibleChildren.length - 1 && hiddenCount === 0;
    const prefix = isLast ? "└ " : "├ ";
    const continuationPrefix = isLast ? "    " : "│   ";

    lines.push(`${prefix}${renderNodeLine(child)}`);

    for (const detail of renderChildDetail(child, continuationPrefix)) {
      lines.push(detail);
    }
  }

  if (hiddenCount > 0) {
    lines.push(`└ _and ${hiddenCount} more..._`);
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

/**
 * Build Slack blocks for a tree-based status message.
 *
 * Renders one or more root nodes as mrkdwn trees with status icons,
 * agent names, task links, durations, progress text, and error details.
 *
 * For in-progress trees, includes a cancel button per active root.
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

  // Add cancel buttons for active roots
  for (const root of roots) {
    if (isTreeActive(root)) {
      blocks.push(cancelActionBlock(root.taskId));
    }
  }

  return blocks;
}
