/**
 * Deterministic icon picker for agent avatars. Lead always gets a crown so
 * the coordinator visually pops. Workers get one of 30 distinct lucide
 * icons seeded by agent id (NOT name — names can change, ids don't).
 */

import {
  Anchor,
  Apple,
  Atom,
  Bird,
  Bot,
  Bug,
  Carrot,
  Cat,
  Cherry,
  Cloud,
  Compass,
  Crown,
  Dog,
  Fish,
  Flower2,
  Leaf,
  type LucideIcon,
  Moon,
  Mountain,
  Plane,
  Rocket,
  Snail,
  Snowflake,
  Sparkles,
  Sprout,
  Squirrel,
  Star,
  Sun,
  Telescope,
  TreeDeciduous,
  Turtle,
} from "lucide-react";

const WORKER_ICONS: LucideIcon[] = [
  Bot,
  Cat,
  Dog,
  Bird,
  Fish,
  Bug,
  Snail,
  Turtle,
  Squirrel,
  Cherry,
  Apple,
  Carrot,
  Leaf,
  Sprout,
  TreeDeciduous,
  Flower2,
  Mountain,
  Sun,
  Moon,
  Cloud,
  Snowflake,
  Sparkles,
  Star,
  Rocket,
  Plane,
  Anchor,
  Compass,
  Telescope,
  Atom,
  Crown, // (also in pool — only worker w/ crown is statistically rare; included to fill 30)
];

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function getAgentIcon(input: {
  agentId?: string | null;
  isLead?: boolean | null;
  role?: string | null;
  agentName?: string | null;
}): LucideIcon {
  const role = input.role?.toLowerCase();
  const name = input.agentName?.toLowerCase();
  if (input.isLead || role === "lead" || name === "lead") return Crown;
  const seed = input.agentId ?? input.agentName ?? "";
  if (!seed) return Bot;
  return WORKER_ICONS[hash(seed) % WORKER_ICONS.length] ?? Bot;
}
