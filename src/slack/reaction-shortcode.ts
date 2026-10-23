import type { ReactionEvent } from "@/integrations/reaction-events";

/** The shared lifecycle events; Slack maps each one to a shortcode below. */
export type SlackReactionEvent = ReactionEvent;

export const SLACK_REACTION_DEFAULTS: Record<SlackReactionEvent, string> = {
  accepted: "eyes",
  buffered: "heavy_plus_sign",
  now: "zap",
  steered: "speech_balloon",
  completed: "white_check_mark",
  failed: "x",
};

export const SLACK_REACTION_CONFIG_KEYS: Record<SlackReactionEvent, string> = {
  accepted: "SLACK_REACTION_ACCEPTED",
  buffered: "SLACK_REACTION_BUFFERED",
  now: "SLACK_REACTION_NOW",
  steered: "SLACK_REACTION_STEERED",
  completed: "SLACK_REACTION_COMPLETED",
  failed: "SLACK_REACTION_FAILED",
};

/**
 * A shortcode, optionally colon-wrapped, plus at most one `::skin-tone-[2-6]`
 * suffix — `reactions.add` accepts names like `thumbsup::skin-tone-6`
 * (https://api.slack.com/methods/reactions.add).
 */
export const SLACK_REACTION_SHORTCODE_PATTERN = /^[a-z0-9_+'-]+(::skin-tone-[2-6])?$/;

export function normalizeSlackReactionShortcode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().replace(/^:/, "").replace(/:$/, "").toLowerCase();
  if (!normalized || !SLACK_REACTION_SHORTCODE_PATTERN.test(normalized)) return null;
  return normalized;
}

export function reactionName(event: SlackReactionEvent): string {
  const raw = process.env[SLACK_REACTION_CONFIG_KEYS[event]];
  const normalized = normalizeSlackReactionShortcode(raw);
  return normalized ?? SLACK_REACTION_DEFAULTS[event];
}

export const SLACK_STATUS_ICON_COMPLETED_KEY = "SLACK_STATUS_ICON_COMPLETED";
export const SLACK_STATUS_ICON_COMPLETED_DEFAULT = "✅";

/**
 * The "done" glyph in thread text (task tree, thread header, outcome cards).
 * Read per call so a global config write, which reloads `process.env`, takes
 * effect without a restart. Unlike a reaction there is no `invalid_name`
 * fallback in text: a name the workspace lacks renders as literal `:name:`.
 */
export function completedStatusIcon(): string {
  const normalized = normalizeSlackReactionShortcode(process.env[SLACK_STATUS_ICON_COMPLETED_KEY]);
  return normalized ? `:${normalized}:` : SLACK_STATUS_ICON_COMPLETED_DEFAULT;
}
