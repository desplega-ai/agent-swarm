/**
 * Deterministically picks a color token for an agent based on its ID.
 *
 * Used by the Sessions surface to give each agent a stable, recognisable
 * accent (left rail, avatar background, dot) across all turns and sessions.
 * The Lead agent always gets `--primary` (amber) so the coordinator pops.
 */

import type { AgentAvatar } from "@/api/types";

/** 8 curated swatches offered in the avatar picker (mirrors the theme
 * token palette below, as concrete hex so a custom pick renders identically
 * whether via inline style or via the token classes). */
export const AVATAR_SUGGESTED_SWATCHES: string[] = [
  "#f59e0b", // primary/amber
  "#3b82f6", // action-agent-task
  "#8b5cf6", // action-script
  "#ec4899", // action-notify
  "#10b981", // action-create-task
  "#06b6d4", // action-send-message
  "#6366f1", // action-delegate-to-agent
  "#64748b", // action-default
];

/** Fallback for the native `<input type="color">`, which only accepts a
 * concrete hex — it has no token form. Lives here so the picker component
 * stays free of hex literals. */
export const AVATAR_COLOR_INPUT_FALLBACK = "#000000";

export type AgentColorToken =
  | "primary"
  | "action-agent-task"
  | "action-script"
  | "action-notify"
  | "action-create-task"
  | "action-send-message"
  | "action-delegate-to-agent"
  | "action-default"
  | "action-raw-llm";

const PALETTE: AgentColorToken[] = [
  "action-agent-task",
  "action-script",
  "action-notify",
  "action-create-task",
  "action-send-message",
  "action-delegate-to-agent",
  "action-default",
  "action-raw-llm",
];

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function getAgentColorToken(input: {
  agentId?: string | null;
  agentName?: string | null;
  role?: string | null;
}): AgentColorToken {
  const role = input.role?.toLowerCase();
  const name = input.agentName?.toLowerCase();
  if (role === "lead" || name === "lead") return "primary";
  const seed = input.agentId ?? input.agentName ?? "";
  if (!seed) return "action-default";
  return PALETTE[hash(seed) % PALETTE.length] ?? "action-default";
}

const RAIL_BG: Record<AgentColorToken, string> = {
  primary: "bg-primary",
  "action-agent-task": "bg-action-agent-task",
  "action-script": "bg-action-script",
  "action-notify": "bg-action-notify",
  "action-create-task": "bg-action-create-task",
  "action-send-message": "bg-action-send-message",
  "action-delegate-to-agent": "bg-action-delegate-to-agent",
  "action-default": "bg-action-default",
  "action-raw-llm": "bg-action-raw-llm",
};

const TINT_BG: Record<AgentColorToken, string> = {
  primary: "bg-primary/15",
  "action-agent-task": "bg-action-agent-task/15",
  "action-script": "bg-action-script/15",
  "action-notify": "bg-action-notify/15",
  "action-create-task": "bg-action-create-task/15",
  "action-send-message": "bg-action-send-message/15",
  "action-delegate-to-agent": "bg-action-delegate-to-agent/15",
  "action-default": "bg-action-default/15",
  "action-raw-llm": "bg-action-raw-llm/15",
};

/** Solid (opaque) colored fill — used for avatars so the timeline spine
 * doesn't show through. Pairs with `text-white` for the initials. */
const SOLID_BG: Record<AgentColorToken, string> = {
  primary: "bg-primary",
  "action-agent-task": "bg-action-agent-task",
  "action-script": "bg-action-script",
  "action-notify": "bg-action-notify",
  "action-create-task": "bg-action-create-task",
  "action-send-message": "bg-action-send-message",
  "action-delegate-to-agent": "bg-action-delegate-to-agent",
  "action-default": "bg-action-default",
  "action-raw-llm": "bg-action-raw-llm",
};

const TEXT: Record<AgentColorToken, string> = {
  primary: "text-primary",
  "action-agent-task": "text-action-agent-task",
  "action-script": "text-action-script",
  "action-notify": "text-action-notify",
  "action-create-task": "text-action-create-task",
  "action-send-message": "text-action-send-message",
  "action-delegate-to-agent": "text-action-delegate-to-agent",
  "action-default": "text-action-default",
  "action-raw-llm": "text-action-raw-llm",
};

export function railBg(token: AgentColorToken) {
  return RAIL_BG[token];
}

export function tintBg(token: AgentColorToken) {
  return TINT_BG[token];
}

export function solidBg(token: AgentColorToken) {
  return SOLID_BG[token];
}

export function tokenText(token: AgentColorToken) {
  return TEXT[token];
}

export type ResolvedAgentColor =
  | { kind: "custom"; hex: string }
  | { kind: "token"; token: AgentColorToken };

/** Resolves an agent's rendered color: a stored custom hex wins (render via
 * inline `style`); unset falls back to the existing deterministic token
 * derivation (render via the `solidBg` Tailwind class). */
export function resolveAgentColor(
  avatar: AgentAvatar | null | undefined,
  fallbackInputs: {
    agentId?: string | null;
    agentName?: string | null;
    role?: string | null;
  },
): ResolvedAgentColor {
  if (avatar?.type === "lucide" && avatar.color) {
    return { kind: "custom", hex: avatar.color };
  }
  return { kind: "token", token: getAgentColorToken(fallbackInputs) };
}

export function agentInitials(name: string | null | undefined, fallbackId?: string): string {
  const source = (name ?? fallbackId ?? "?").trim();
  if (source.length === 0) return "?";
  const parts = source.split(/[\s_\-.]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}
