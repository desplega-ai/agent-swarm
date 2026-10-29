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
  /** A shared/forwarded message (`is_share`) carries its files here, not at top level. */
  files?: unknown[];
}

// Internal shape used only inside the helper; callers pass `blocks?: unknown[]`
interface SlackBlockInternal {
  type?: string;
  text?: { type?: string; text?: string };
  /** section blocks may use fields[] instead of (or alongside) a top-level text object */
  fields?: Array<{ type?: string; text?: string }>;
  elements?: unknown[];
  /** table / data_table blocks: one array of cells per row, header row first */
  rows?: unknown[];
  /** data_table blocks */
  caption?: string;
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
 * Render one inline rich_text element tree as a single line. Unlike
 * collectRichTextParts this keeps links, mentions and emoji, since a table
 * cell has no `msg.text` twin to recover them from.
 */
function renderRichTextInline(node: unknown): string {
  if (node == null || typeof node !== "object") return "";
  const n = node as {
    type?: string;
    text?: string;
    url?: string;
    user_id?: string;
    channel_id?: string;
    usergroup_id?: string;
    range?: string;
    name?: string;
    fallback?: string;
    elements?: unknown[];
  };
  switch (n.type) {
    case "text":
      return n.text ?? "";
    case "link":
      if (!n.url) return n.text ?? "";
      return n.text && n.text !== n.url ? `[${n.text}](${n.url})` : n.url;
    case "user":
      return n.user_id ? `<@${n.user_id}>` : "";
    case "channel":
      return n.channel_id ? `<#${n.channel_id}>` : "";
    case "usergroup":
      return n.usergroup_id ? `<!subteam^${n.usergroup_id}>` : "";
    case "broadcast":
      return n.range ? `<!${n.range}>` : "";
    case "emoji":
      return n.name ? `:${n.name}:` : "";
    case "date":
      return n.fallback ?? n.text ?? "";
  }
  if (!Array.isArray(n.elements)) return n.text ?? "";
  // Containers: inline runs concatenate; sections, list items and quotes are
  // separate blocks, so keep a space between them.
  const inline = n.type === "rich_text_section" || n.type === "rich_text_preformatted";
  return n.elements
    .map(renderRichTextInline)
    .filter(Boolean)
    .join(inline ? "" : " ");
}

/** Plain text of a table cell: raw_text, raw_number or rich_text. */
function renderTableCell(cell: unknown): string {
  if (cell == null || typeof cell !== "object") return "";
  const c = cell as { type?: string; text?: string; value?: number };
  let text: string;
  if (c.type === "rich_text") text = renderRichTextInline(cell);
  else if (typeof c.text === "string") text = c.text;
  else if (typeof c.value === "number") text = String(c.value);
  else text = "";
  // One row per line, one column per pipe.
  return text
    .replace(/\s*\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * Render a table / data_table block as a markdown table: header row first,
 * then one line per row, in order. Returns "" for a table with no cell text.
 */
function renderTableBlock(block: SlackBlockInternal): string {
  const rows = (block.rows ?? []).filter(Array.isArray).map((row) => row.map(renderTableCell));
  if (!rows.some((cells) => cells.some(Boolean))) return "";
  // Pad every row, header included, to the widest row so the header separator
  // and each line have the same column count.
  const width = Math.max(...rows.map((cells) => cells.length));
  const lines: string[] = [];
  for (const cells of rows) {
    const padded = [...cells, ...Array<string>(width - cells.length).fill("")];
    lines.push(`| ${padded.join(" | ")} |`);
    // Markdown header separator after the first (header) row.
    if (lines.length === 1) lines.push(`|${" --- |".repeat(width)}`);
  }
  const caption = block.caption?.trim();
  return caption ? `${caption}\n${lines.join("\n")}` : lines.join("\n");
}

function isTableBlock(block: unknown): boolean {
  if (block == null || typeof block !== "object") return false;
  const type = (block as { type?: string }).type;
  return (
    (type === "table" || type === "data_table") && Array.isArray((block as SlackBlockInternal).rows)
  );
}

/**
 * Turn top-level mrkdwn `text` into the plain text a rich_text block flattens
 * to: drop `<…>` tokens (user/channel mentions, links, `<!here>`), which
 * collectRichTextParts does not emit, then decode Slack's HTML escapes.
 */
function decodeMrkdwn(text: string): string {
  return text
    .replace(/<[^<>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Normalize text for the text-vs-rich_text equality check only (never for
 * output): drop emoji shortcodes, quote and list markers, and mrkdwn style
 * characters, which rich_text carries as element types or style flags rather
 * than characters, then all whitespace, since flattening joins styled runs
 * with newlines.
 */
function normalizeForDedupe(text: string): string {
  return text
    .replace(/:[a-z0-9_+'-]+:/gi, "")
    .replace(/^[ \t]*(?:>|[•◦▪‣-]|\d+\.)[ \t]*/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, "");
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
 * printing it twice. A rich_text block whose content equals `msg.text` after
 * normalization is omitted instead (see below).
 *
 * Block types extracted: section (text + fields), rich_text, header, context,
 * actions (button label + url as mrkdwn link), table and data_table (as a
 * markdown table, header row first). A table never takes part in the
 * text-vs-rich_text dedupe: `msg.text` does not carry its cells.
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
  // Index range of each rich_text block's parts inside blockParts, so a
  // rich_text block that merely re-renders `msg.text` can be dropped below.
  const richTextRanges: Array<[number, number]> = [];
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
        const start = blockParts.length;
        for (const el of block.elements) {
          collectRichTextParts(el, blockParts);
        }
        if (blockParts.length > start) richTextRanges.push([start, blockParts.length]);
      } else if (isTableBlock(block)) {
        const table = renderTableBlock(block);
        if (table) blockParts.push(table);
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

  // A human message carries the same content twice: `text` (mrkdwn) and a
  // rich_text block. The block flattens to one part per styled run, so the
  // per-line check below never matches a multi-line or formatted message and
  // the whole message would render twice. When the rich_text content equals
  // `text` after normalization, keep `text` (it also carries the mentions,
  // links and emoji the rich_text flattening drops) and skip the blocks.
  let bodyBlockParts = blockParts;
  if (topText && richTextRanges.length > 0) {
    const richText = richTextRanges
      .map(([start, end]) => blockParts.slice(start, end).join("\n"))
      .join("\n");
    if (normalizeForDedupe(richText) === normalizeForDedupe(decodeMrkdwn(topText))) {
      const dropped = new Set<number>();
      for (const [start, end] of richTextRanges) {
        for (let i = start; i < end; i++) dropped.add(i);
      }
      bodyBlockParts = blockParts.filter((_, i) => !dropped.has(i));
    }
  }

  const bodyText = [...attachmentParts, ...bodyBlockParts].filter(Boolean).join("\n");

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

/**
 * Text for an inbound Slack message (task creation, thread buffer). Inbound
 * has always used `msg.text`, which for a human message mirrors its rich_text
 * block. A table block is the exception: `msg.text` stops before it, so when
 * one is present use the full extraction, which renders the table.
 */
export function slackInboundMessageText(msg: SlackMessageLike): string {
  if (Array.isArray(msg.blocks) && msg.blocks.some(isTableBlock)) {
    return extractSlackMessageText(msg);
  }
  return msg.text ?? "";
}

/**
 * Every file on a Slack message: top-level `files`, then the files of any
 * shared/forwarded message in `attachments[].files`, deduped by file id.
 * Sharing a message with an image into a thread leaves top-level `files`
 * empty and puts the image on the attachment.
 */
export function collectSlackMessageFiles<F extends { id: string }>(msg: {
  files?: F[] | null;
  attachments?: Array<{ files?: unknown[] | null }> | null;
}): F[] {
  const seen = new Set<string>();
  const out: F[] = [];
  const add = (file: unknown) => {
    if (file == null || typeof file !== "object") return;
    const id = (file as { id?: unknown }).id;
    if (typeof id !== "string" || !id || seen.has(id)) return;
    seen.add(id);
    out.push(file as F);
  };
  for (const file of msg.files ?? []) add(file);
  for (const attachment of msg.attachments ?? []) {
    if (attachment == null || typeof attachment !== "object") continue;
    for (const file of attachment.files ?? []) add(file);
  }
  return out;
}

/**
 * Normalize a Slack message timestamp into the dotted API form
 * (1783411554.596189) that chat.delete/chat.update require.
 *
 * Accepts, in order of preference:
 *   - the dotted API form            → "1783411554.596189"  (returned unchanged)
 *   - the 'p' deep-link form         → "p1783411554596189"  (dot re-inserted)
 *   - the bare digit run             → "1783411554596189"
 *   - a full Slack permalink URL     → ".../archives/C.../p1783411554596189?thread_ts=..."
 *
 * The Lead can pass whatever handle it holds; this makes delete/edit reliable
 * without the caller pre-cleaning the input.
 */
export function parseSlackTs(input: string): string {
  const trimmed = input.trim();
  if (/^\d{6,}\.\d{1,}$/.test(trimmed)) return trimmed; // already dotted

  // Extract the p-form / bare digit run from anywhere in the string,
  // including a full permalink URL (…/archives/C…/p1783411554596189?…).
  const m = trimmed.match(/p?(\d{10})(\d{6})(?:\D|$)/);
  if (m) return `${m[1]}.${m[2]}`;

  return trimmed; // fall through; Slack rejects a bad ts with a clear error we map below
}
