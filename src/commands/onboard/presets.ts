import type { ServiceEntry } from "./types.ts";

export interface Preset {
  id: string;
  name: string;
  description: string;
  services: ServiceEntry[];
}

export const PRESETS: Preset[] = [
  {
    // Keep this first: Ink's Select uses the first option as the interactive default.
    id: "full",
    name: "Full Swarm",
    description: "All official agent profiles, ready to coordinate a complete swarm.",
    services: [
      { template: "official/lead", displayName: "Lead", count: 1, role: "lead", isLead: true },
      { template: "official/coder", displayName: "Coder", count: 1, role: "coder" },
      {
        template: "official/content-reviewer",
        displayName: "Content Reviewer",
        count: 1,
        role: "content-reviewer",
      },
      {
        template: "official/content-strategist",
        displayName: "Content Strategist",
        count: 1,
        role: "content-strategist",
      },
      {
        template: "official/content-writer",
        displayName: "Content Writer",
        count: 1,
        role: "content-writer",
      },
      {
        template: "official/discoverability-optimizer",
        displayName: "Discoverability Optimizer",
        count: 1,
        role: "discoverability-optimizer",
      },
      {
        template: "official/forward-deployed-engineer",
        displayName: "Forward Deployed Engineer",
        count: 1,
        role: "forward-deployed-engineer",
      },
      {
        template: "official/researcher",
        displayName: "Researcher",
        count: 1,
        role: "researcher",
      },
      { template: "official/reviewer", displayName: "Reviewer", count: 1, role: "reviewer" },
      { template: "official/tester", displayName: "Tester", count: 1, role: "tester" },
      {
        template: "official/ux-principles",
        displayName: "UX Principles Agent",
        count: 1,
        role: "ux-principles",
      },
    ],
  },
  {
    id: "dev",
    name: "Development Team",
    description: "Build software with a lead coordinator and two coding agents.",
    services: [
      { template: "official/lead", displayName: "Lead", count: 1, role: "lead", isLead: true },
      { template: "official/coder", displayName: "Coder", count: 2, role: "coder" },
    ],
  },
  {
    id: "content",
    name: "Content Team",
    description: "Content creation pipeline with writing, review, and strategy.",
    services: [
      { template: "official/lead", displayName: "Lead", count: 1, role: "lead", isLead: true },
      {
        template: "official/content-writer",
        displayName: "Content Writer",
        count: 1,
        role: "content-writer",
      },
      {
        template: "official/content-reviewer",
        displayName: "Content Reviewer",
        count: 1,
        role: "content-reviewer",
      },
      {
        template: "official/content-strategist",
        displayName: "Content Strategist",
        count: 1,
        role: "content-strategist",
      },
    ],
  },
  {
    id: "research",
    name: "Research Team",
    description: "Research and analysis with peer review.",
    services: [
      { template: "official/lead", displayName: "Lead", count: 1, role: "lead", isLead: true },
      {
        template: "official/researcher",
        displayName: "Researcher",
        count: 1,
        role: "researcher",
      },
      { template: "official/reviewer", displayName: "Reviewer", count: 1, role: "reviewer" },
    ],
  },
  {
    id: "solo",
    name: "Solo Agent",
    description: "Single agent, simplest setup.",
    services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
  },
  {
    id: "custom",
    name: "Custom",
    description: "Choose your own templates.",
    services: [],
  },
];

export function getPresetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function getAgentCount(services: ServiceEntry[]): number {
  return services.reduce((sum, s) => sum + s.count, 0);
}

export function getAgentSummary(services: ServiceEntry[]): string {
  return services.map((s) => `${s.count} ${s.displayName.toLowerCase()}`).join(" + ");
}
