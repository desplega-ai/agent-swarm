// Bot name for @mentions (can be overridden via env)
export const GITHUB_BOT_NAME = process.env.GITHUB_BOT_NAME || "agent-swarm-bot";

// Labels that trigger agent action on PR/issue label events (comma-separated env var)
const GITHUB_EVENT_LABELS_RAW = process.env.GITHUB_EVENT_LABELS || "swarm-review";
export const GITHUB_EVENT_LABELS: string[] = GITHUB_EVENT_LABELS_RAW.split(",")
  .map((l) => l.trim().toLowerCase())
  .filter(Boolean);

export function isSwarmLabel(label: string): boolean {
  return GITHUB_EVENT_LABELS.includes(label.toLowerCase());
}

// Additional aliases that also trigger the bot (comma-separated env var)
// Example: GITHUB_BOT_ALIASES=heysidekick,sidekick,review-bot
function computeBotNames(): string[] {
  const primary = GITHUB_BOT_NAME.toLowerCase();
  const aliases = (process.env.GITHUB_BOT_ALIASES || "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([primary, ...aliases])];
}

function computeMentionPattern(names: string[]): RegExp {
  return new RegExp(
    `@(${names.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
    "i",
  );
}

export let BOT_NAMES: string[] = computeBotNames();

// Pattern to detect @<any-name> mentions (case-insensitive)
let MENTION_PATTERN = computeMentionPattern(BOT_NAMES);

/** Recompute BOT_NAMES and MENTION_PATTERN from current env. For testing only. */
export function _resetBotNamesForTesting(): void {
  BOT_NAMES = computeBotNames();
  MENTION_PATTERN = computeMentionPattern(BOT_NAMES);
}

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
