// Bot name for @mentions (can be overridden via env)
export const GITHUB_BOT_NAME = process.env.GITHUB_BOT_NAME || "agent-swarm-bot";

// Additional aliases that also trigger the bot (comma-separated env var)
// Example: GITHUB_BOT_ALIASES=heysidekick,sidekick,review-bot
const BOT_NAMES: string[] = (() => {
  const primary = GITHUB_BOT_NAME.toLowerCase();
  const aliases = (process.env.GITHUB_BOT_ALIASES || "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([primary, ...aliases])];
})();

// Pattern to detect @<any-name> mentions (case-insensitive)
const MENTION_PATTERN = new RegExp(
  `@(${BOT_NAMES.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

/**
 * Check if text contains @<bot-name-or-alias> mention
 */
export function detectMention(text: string | null | undefined): boolean {
  if (!text) return false;
  return MENTION_PATTERN.test(text);
}

/**
 * Extract context by removing the @<bot-name-or-alias> mention from text
 * Returns the remaining text trimmed
 */
export function extractMentionContext(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(MENTION_PATTERN, "").trim();
}

/**
 * Check if the assignee matches our bot name or any alias (case-insensitive)
 */
export function isBotAssignee(assigneeLogin: string | undefined): boolean {
  if (!assigneeLogin) return false;
  return BOT_NAMES.includes(assigneeLogin.toLowerCase());
}
