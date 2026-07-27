/**
 * Deterministic icon picker for agent avatars. Lead always gets a crown so
 * the coordinator visually pops. Workers get one of 30 distinct lucide
 * icons seeded by agent id (NOT name — names can change, ids don't).
 */

import {
  Anchor,
  Apple,
  Atom,
  Award,
  Bird,
  Book,
  Bot,
  Box,
  Briefcase,
  Bug,
  Camera,
  Carrot,
  Cat,
  Cherry,
  Cloud,
  Coffee,
  Compass,
  Crown,
  Diamond,
  Dog,
  Droplet,
  Feather,
  Fish,
  Flag,
  Flame,
  Flower2,
  Gem,
  Ghost,
  Gift,
  Globe,
  Heart,
  Key,
  Leaf,
  Lock,
  type LucideIcon,
  Map as MapIcon,
  Moon,
  Mountain,
  Music,
  Package,
  Palette,
  Pizza,
  Plane,
  Puzzle,
  Rabbit,
  Rocket,
  Shield,
  Skull,
  Snail,
  Snowflake,
  Sparkles,
  Sprout,
  Squirrel,
  Star,
  Sun,
  Sword,
  Target,
  Telescope,
  TreeDeciduous,
  Trophy,
  Turtle,
  Umbrella,
  Wand2,
  Zap,
} from "lucide-react";
import type { AgentAvatar } from "@/api/types";

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

/**
 * Curated catalog for the avatar picker + custom-avatar renderer. Superset of
 * `WORKER_ICONS` (kept separate — that pool stays untouched so the
 * deterministic fallback for existing agents never shifts). Keys are the
 * kebab-case names stored in `AgentAvatar.icon`; adding an icon here is a
 * UI-only change (no migration, no server change — the server only validates
 * the kebab-case shape).
 */
export const AVATAR_ICON_CATALOG: Record<string, LucideIcon> = {
  bot: Bot,
  cat: Cat,
  dog: Dog,
  bird: Bird,
  fish: Fish,
  bug: Bug,
  snail: Snail,
  turtle: Turtle,
  squirrel: Squirrel,
  rabbit: Rabbit,
  cherry: Cherry,
  apple: Apple,
  carrot: Carrot,
  leaf: Leaf,
  sprout: Sprout,
  "tree-deciduous": TreeDeciduous,
  flower: Flower2,
  mountain: Mountain,
  sun: Sun,
  moon: Moon,
  cloud: Cloud,
  snowflake: Snowflake,
  sparkles: Sparkles,
  star: Star,
  rocket: Rocket,
  plane: Plane,
  anchor: Anchor,
  compass: Compass,
  telescope: Telescope,
  atom: Atom,
  crown: Crown,
  award: Award,
  book: Book,
  box: Box,
  briefcase: Briefcase,
  camera: Camera,
  coffee: Coffee,
  diamond: Diamond,
  droplet: Droplet,
  feather: Feather,
  flag: Flag,
  flame: Flame,
  gem: Gem,
  ghost: Ghost,
  gift: Gift,
  globe: Globe,
  heart: Heart,
  key: Key,
  lock: Lock,
  map: MapIcon,
  music: Music,
  package: Package,
  palette: Palette,
  pizza: Pizza,
  puzzle: Puzzle,
  shield: Shield,
  skull: Skull,
  sword: Sword,
  target: Target,
  trophy: Trophy,
  umbrella: Umbrella,
  wand: Wand2,
  zap: Zap,
};

/** Resolves an agent's rendered icon: stored catalog icon wins; unset/unknown
 * falls back to the existing deterministic derivation, so a stale or
 * hand-set icon name can never break rendering. */
export function resolveAgentIcon(
  avatar: AgentAvatar | null | undefined,
  fallbackInputs: {
    agentId?: string | null;
    isLead?: boolean | null;
    role?: string | null;
    agentName?: string | null;
  },
): LucideIcon {
  if (avatar?.type === "lucide") {
    const catalogIcon = AVATAR_ICON_CATALOG[avatar.icon];
    if (catalogIcon) return catalogIcon;
  }
  return getAgentIcon(fallbackInputs);
}
