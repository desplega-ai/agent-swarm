import {
  Bot,
  CalendarClock,
  CircleDot,
  Code,
  Cog,
  type LucideIcon,
  Mail,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Workflow,
} from "lucide-react";
import { BrandLogo } from "@/components/shared/brand-logo";
import { cn } from "@/lib/utils";

const TASK_SOURCE_LABELS: Record<string, string> = {
  agentmail: "Email",
  api: "API",
  bitbucket: "Bitbucket",
  chat: "Chat",
  comb: "Comb",
  discord: "Discord",
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  linear: "Linear",
  mcp: "MCP",
  schedule: "Schedule",
  slack: "Slack",
  system: "System",
  telegram: "Telegram",
  ui: "Dashboard",
  workflow: "Workflow",
};

/** Where a task came from, as people say it ("Slack", "GitHub", "Dashboard"). */
export function taskSourceLabel(source: string): string {
  return TASK_SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

/** Monochrome marks in `public/integration-logos/`. */
const SOURCE_LOGOS: Record<string, string> = {
  slack: "/integration-logos/slack.svg",
  telegram: "/integration-logos/telegram.svg",
  discord: "/integration-logos/discord.svg",
  github: "/integration-logos/github.svg",
  gitlab: "/integration-logos/gitlab.svg",
  bitbucket: "/integration-logos/bitbucket.svg",
  linear: "/integration-logos/linear.svg",
  jira: "/integration-logos/jira.svg",
};

/** Icons for the sources that have no brand mark. */
const SOURCE_ICONS: Record<string, LucideIcon> = {
  agentmail: Mail,
  api: Code,
  chat: MessageSquare,
  comb: MessagesSquare,
  mcp: Bot,
  schedule: CalendarClock,
  system: Cog,
  ui: Monitor,
  workflow: Workflow,
};

/** The mark of a task source: its brand logo, else a matching icon. 14 px unless `className` sizes it. */
export function TaskSourceMark({ source, className }: { source: string; className?: string }) {
  const logo = SOURCE_LOGOS[source];
  if (logo) return <BrandLogo src={logo} className={cn("size-3.5", className)} />;
  const Icon = SOURCE_ICONS[source] ?? CircleDot;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />;
}
