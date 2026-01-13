// Bot name for @mentions (can be overridden via env)
export const GITHUB_BOT_NAME = process.env.GITHUB_BOT_NAME || "agent-swarm-bot";

// Pattern to detect @<bot-name> mentions (case-insensitive)
const MENTION_PATTERN = new RegExp(`@${GITHUB_BOT_NAME}\\b`, "i");

/**
 * Check if text contains @<bot-name> mention
 */
export function detectMention(text: string | null | undefined): boolean {
  if (!text) return false;
  return MENTION_PATTERN.test(text);
}

/**
 * Extract context by removing the @<bot-name> mention from text
 * Returns the remaining text trimmed
 */
export function extractMentionContext(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(MENTION_PATTERN, "").trim();
}
