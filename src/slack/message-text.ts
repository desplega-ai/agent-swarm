/**
 * Shared utility for extracting displayable text from a Slack message.
 *
 * Slack integration/alert apps (Datadog, PagerDuty, GitHub) often post with
 * an empty top-level `text` field and put all content in legacy `attachments`
 * or Block Kit `blocks`. This helper falls back through those layers so callers
 * never silently drop those messages.
 */

interface SlackAttachment {
  fallback?: string;
  text?: string;
  title?: string;
  pretext?: string;
}

// Internal shape used only inside the helper; callers pass `blocks?: unknown[]`
interface SlackBlockInternal {
  type?: string;
  text?: { type?: string; text?: string };
  elements?: Array<{
    type?: string;
    text?: string;
    elements?: Array<{ type?: string; text?: string }>;
  }>;
}

export interface SlackMessageLike {
  text?: string;
  attachments?: SlackAttachment[];
  /** Typed as unknown[] so any Slack SDK block variant is accepted without casting. */
  blocks?: unknown[];
}

/**
 * Return the best displayable text for a Slack message.
 *
 * Priority:
 * 1. `msg.text` (non-empty)
 * 2. `msg.attachments[]` — joins `fallback || text || title || pretext` for each
 * 3. `msg.blocks[]` — extracts text from section and rich_text blocks
 * 4. `""` if nothing found
 */
export function extractSlackMessageText(msg: SlackMessageLike): string {
  if (msg.text?.trim()) return msg.text;

  // Legacy attachments (Datadog, PagerDuty, GitHub alert apps)
  if (msg.attachments && msg.attachments.length > 0) {
    const parts = msg.attachments
      .map((a) => a.fallback || a.text || a.title || a.pretext || "")
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }

  // Block Kit blocks
  if (msg.blocks && msg.blocks.length > 0) {
    const parts: string[] = [];
    for (const rawBlock of msg.blocks) {
      const block = rawBlock as SlackBlockInternal;
      if (block.type === "section" && block.text?.text) {
        parts.push(block.text.text);
      } else if (block.type === "rich_text" && block.elements) {
        for (const el of block.elements) {
          if (el.elements) {
            for (const inner of el.elements) {
              if (inner.type === "text" && inner.text) parts.push(inner.text);
            }
          }
        }
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }

  return "";
}
