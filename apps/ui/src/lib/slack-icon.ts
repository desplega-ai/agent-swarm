import type { AgentSlackIcon } from "@/api/types";

// Mirrors AgentSlackIconSchema (src/types.ts); src/tests/agent-slack-icon.test.ts checks parity.
const EMOJI_PATTERN = /^:[a-z0-9_+'-]+:$/;
const MAX_EMOJI_LENGTH = 102;
const MAX_URL_LENGTH = 2048;

export type SlackIconInput =
  | { ok: true; icon: AgentSlackIcon | null }
  | { ok: false; error: string };

/** Blank resets; `owl` becomes `:owl:`. */
export function parseSlackIconInput(text: string): SlackIconInput {
  const value = text.trim();
  if (!value) return { ok: true, icon: null };
  if (/^https?:/i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, error: "Enter a valid image URL." };
    }
    if (url.protocol !== "https:") return { ok: false, error: "Use an https URL." };
    if (url.username || url.password) {
      return { ok: false, error: "Remove the username and password from the URL." };
    }
    if (value.length > MAX_URL_LENGTH) return { ok: false, error: "The URL is too long." };
    return { ok: true, icon: { type: "url", url: value } };
  }
  const emoji = `:${value.toLowerCase().replace(/^:|:$/g, "")}:`;
  if (emoji.length > MAX_EMOJI_LENGTH || !EMOJI_PATTERN.test(emoji)) {
    return { ok: false, error: "Use an emoji code like :owl: or an https image URL." };
  }
  return { ok: true, icon: { type: "emoji", emoji } };
}

export function formatSlackIcon(icon: AgentSlackIcon | null | undefined): string {
  if (!icon || icon.type === "app") return "";
  return icon.type === "url" ? icon.url : icon.emoji;
}
