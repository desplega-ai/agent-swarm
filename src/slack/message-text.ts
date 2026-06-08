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
  /** section blocks may use fields[] instead of (or alongside) a top-level text object */
  fields?: Array<{ type?: string; text?: string }>;
  elements?: unknown[];
}

export interface SlackMessageLike {
  text?: string;
  attachments?: SlackAttachment[];
  /** Typed as unknown[] so any Slack SDK block variant is accepted without casting. */
  blocks?: unknown[];
}

/**
 * Recursively collect plain text from a Slack rich_text node tree.
 *
 * Handles text leaf nodes plus all container types that carry child elements:
 * rich_text_section, rich_text_list, rich_text_quote, rich_text_preformatted.
 */
function collectRichTextParts(node: unknown, parts: string[]): void {
  if (node == null || typeof node !== "object") return;
  const n = node as { type?: string; text?: string; elements?: unknown[] };
  if (n.type === "text" && n.text) {
    parts.push(n.text);
  }
  if (Array.isArray(n.elements)) {
    for (const child of n.elements) {
      collectRichTextParts(child, parts);
    }
  }
}

/**
 * Return the best displayable text for a Slack message.
 *
 * Priority:
 * 1. `msg.text` (non-empty)
 * 2. `msg.attachments[]` — joins `fallback || text || title || pretext` for each
 * 3. `msg.blocks[]` — extracts text from section (text + fields) and rich_text blocks
 * 4. `""` if nothing found
 */
export function extractSlackMessageText(msg: SlackMessageLike): string {
  if (msg.text?.trim()) return msg.text;

  // Legacy attachments (Datadog, PagerDuty, GitHub alert apps)
  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    const parts = msg.attachments
      .filter((a): a is SlackAttachment => a != null && typeof a === "object")
      .map((a) => a.fallback || a.text || a.title || a.pretext || "")
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }

  // Block Kit blocks
  if (Array.isArray(msg.blocks) && msg.blocks.length > 0) {
    const parts: string[] = [];
    for (const rawBlock of msg.blocks) {
      if (rawBlock == null || typeof rawBlock !== "object") continue;
      const block = rawBlock as SlackBlockInternal;
      if (block.type === "section") {
        if (block.text?.text) parts.push(block.text.text);
        if (Array.isArray(block.fields)) {
          for (const field of block.fields) {
            if (field != null && typeof field === "object" && field.text) {
              parts.push(field.text);
            }
          }
        }
      } else if (block.type === "rich_text" && Array.isArray(block.elements)) {
        for (const el of block.elements) {
          collectRichTextParts(el, parts);
        }
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }

  return "";
}
