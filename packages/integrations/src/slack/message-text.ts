/**
 * Shared utility for extracting displayable text from a Slack message.
 *
 * Slack integration/alert apps (Datadog, PagerDuty, GitHub) often post with
 * a short fallback summary in `text` and put all real content in Block Kit
 * `blocks` or legacy `attachments`. This helper collects ALL layers so callers
 * never silently drop that content.
 */

interface SlackAttachment {
  fallback?: string;
  text?: string;
  title?: string;
  title_link?: string;
  pretext?: string;
  fields?: Array<{ title?: string; value?: string }>;
  actions?: Array<{ text?: string; url?: string }>;
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
 * Return displayable text for a Slack message, combining ALL content layers.
 *
 * Collection order: msg.text → msg.attachments[] → msg.blocks[]
 *
 * All three layers are collected and joined rather than returning at the first
 * non-empty layer. Alert apps (Datadog, PagerDuty, GitHub) put a short fallback
 * summary in `msg.text` and the real content (PoC, error rate, tags, trace URLs)
 * in blocks — the old short-circuit on `msg.text` silently dropped all of that.
 *
 * Dedup: if `msg.text` is already contained verbatim in the combined
 * attachments+blocks body (fallback echoed in a block), it is omitted to avoid
 * printing it twice.
 *
 * Block types extracted: section (text + fields), rich_text, header, context,
 * actions (button label + url as mrkdwn link).
 * Attachment extras extracted: fields[] (title/value), title_link, actions[].url.
 */
export function extractSlackMessageText(msg: SlackMessageLike): string {
  const topText = msg.text?.trim() ?? "";

  // Legacy attachments (Datadog, PagerDuty, GitHub alert apps)
  const attachmentParts: string[] = [];
  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    for (const raw of msg.attachments) {
      if (raw == null || typeof raw !== "object") continue;
      const a = raw as SlackAttachment;
      const attParts: string[] = [];

      // Collect all non-empty primary text fields as separate parts; dedup exact matches.
      // fallback is a short notification-only summary — text often carries the full body,
      // so we must not let fallback suppress text via short-circuit (a.fallback || a.text).
      // Prefer a mrkdwn link for title when title_link is present.
      const titleText = a.title_link && a.title ? `<${a.title_link}|${a.title}>` : a.title;
      const seenPrimary = new Set<string>();
      for (const part of [a.pretext, titleText, a.text, a.fallback]) {
        const s = part?.trim();
        if (s && !seenPrimary.has(s)) {
          seenPrimary.add(s);
          attParts.push(s);
        }
      }

      // Datadog-style attachment fields (title/value pairs)
      if (Array.isArray(a.fields)) {
        for (const field of a.fields) {
          if (field == null || typeof field !== "object") continue;
          const f = field as { title?: string; value?: string };
          if (f.title && f.value) attParts.push(`${f.title}: ${f.value}`);
          else if (f.title) attParts.push(f.title);
          else if (f.value) attParts.push(f.value);
        }
      }

      // Legacy attachment action URLs
      if (Array.isArray(a.actions)) {
        for (const action of a.actions) {
          if (action == null || typeof action !== "object") continue;
          const act = action as { text?: string; url?: string };
          if (act.url) {
            attParts.push(act.text ? `<${act.url}|${act.text}>` : act.url);
          }
        }
      }

      if (attParts.length > 0) attachmentParts.push(attParts.join("\n"));
    }
  }

  // Block Kit blocks
  const blockParts: string[] = [];
  if (Array.isArray(msg.blocks) && msg.blocks.length > 0) {
    for (const rawBlock of msg.blocks) {
      if (rawBlock == null || typeof rawBlock !== "object") continue;
      const block = rawBlock as SlackBlockInternal;
      if (block.type === "section") {
        if (block.text?.text) blockParts.push(block.text.text);
        if (Array.isArray(block.fields)) {
          for (const field of block.fields) {
            if (field != null && typeof field === "object" && field.text) {
              blockParts.push(field.text);
            }
          }
        }
      } else if (block.type === "rich_text" && Array.isArray(block.elements)) {
        for (const el of block.elements) {
          collectRichTextParts(el, blockParts);
        }
      } else if (block.type === "header") {
        if (block.text?.text) blockParts.push(block.text.text);
      } else if (block.type === "context" && Array.isArray(block.elements)) {
        for (const el of block.elements) {
          if (el == null || typeof el !== "object") continue;
          const e = el as { type?: string; text?: string };
          if (e.text) blockParts.push(e.text);
        }
      } else if (block.type === "actions" && Array.isArray(block.elements)) {
        for (const el of block.elements) {
          if (el == null || typeof el !== "object") continue;
          const e = el as { type?: string; text?: { type?: string; text?: string }; url?: string };
          const label = e.text?.text;
          const url = e.url;
          if (label && url) blockParts.push(`<${url}|${label}>`);
          else if (label) blockParts.push(label);
          else if (url) blockParts.push(url);
        }
      }
    }
  }

  const bodyText = [...attachmentParts, ...blockParts].filter(Boolean).join("\n");

  // Include the top-level text unless it already appears as a complete line in the body.
  // Boundary-aware check: "hi".includes check would silently drop "hi" when the body
  // contains "this" (substring match). Compare against trimmed lines instead.
  const bodyLines = new Set(
    bodyText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  if (topText && !bodyLines.has(topText)) {
    return bodyText ? `${topText}\n${bodyText}` : topText;
  }
  return bodyText || topText;
}
