/**
 * Per-adapter message length limits, in UTF-16 code units (what the platforms
 * count). Outbound text longer than the limit is split into several messages.
 */
const CHAT_MESSAGE_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  // Slack messages use mrkdwn, not markdown. The SDK posts our markdown as
  // `markdown_text` (Slack converts it, 12000 character cap). 4000 is Slack's
  // guidance for one readable message and stays well under that cap.
  slack: 4000,
  teams: 20000,
};

/** Used for an adapter without an entry: the smallest known limit. */
const FALLBACK_LIMIT = 2000;

export function chatMessageLimit(adapter: string): number {
  return CHAT_MESSAGE_LIMITS[adapter] ?? FALLBACK_LIMIT;
}

/**
 * Split `text` into chunks of at most `limit` characters. A chunk ends at the
 * last line break inside the window, else at the last space, else at the
 * limit. Breaks in the first half of the window are ignored, so chunks never
 * get very short.
 */
export function splitChatMessage(text: string, limit: number): string[] {
  if (limit <= 0) throw new Error("splitChatMessage: limit must be positive");
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const minBreak = Math.floor(limit / 2);
    let cut = window.lastIndexOf("\n");
    if (cut < minBreak) cut = window.lastIndexOf(" ");
    if (cut < minBreak) {
      cut = limit;
      // Never split a surrogate pair (emoji and other astral characters).
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^[\n ]+/, "");
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  return chunks.filter((chunk, index) => chunk.length > 0 || index === 0);
}
