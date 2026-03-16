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
}): SlackBlock[] {
  const taskLink = getTaskLink(opts.taskId);
  let line = `✅ *${opts.agentName}* (${taskLink})`;
  if (opts.duration) line += ` · ${opts.duration}`;

  const blocks: SlackBlock[] = [sectionBlock(line)];
  for (const chunk of splitText(opts.body)) {
    blocks.push(sectionBlock(chunk));
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
    sectionBlock(`⏳ *${opts.agentName}* (\`${shortId}\`): ${opts.progress}`),
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
