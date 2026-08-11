/**
 * Built-in meeting templates — small in-code registry that scaffolds a
 * meeting's agenda and suggested speaking rounds. Ported (concept, not the
 * markdown-file plumbing) from CronusL-1141/AI-company's Meetings feature: we
 * keep templates in code for v1 so the API server needs no filesystem-template
 * loader. Filesystem/markdown templates with YAML frontmatter are a natural
 * follow-up if the set grows.
 */
import type { MeetingTemplate } from "@/types";

const TEMPLATES: Record<string, MeetingTemplate> = {
  decision: {
    key: "decision",
    title: "Decision",
    description: "Reach one clear, actionable decision on a specific question.",
    agenda: "Decide: <state the exact question here>. Constraints, options, and the call.",
    rounds: [
      "State the problem, constraints, and what a good decision looks like.",
      "Each participant proposes an option with tradeoffs.",
      "Converge: the leader records the decision and owner.",
    ],
  },
  debate: {
    key: "debate",
    title: "Debate",
    description: "Adversarial pressure-test of a high-stakes design or code choice.",
    agenda: "Debate: <state the proposal>. Advocate vs Critic, then a judged conclusion.",
    rounds: [
      "Advocate: make the strongest case for the proposal.",
      "Critic: attack it — risks, failure modes, cheaper alternatives.",
      "Response: advocate rebuts the strongest objections.",
      "Judge: the leader rules and records the decision + rationale.",
    ],
  },
  retro: {
    key: "retro",
    title: "Retro",
    description: "Review what happened and extract concrete improvements.",
    agenda: "Retro: <what are we reviewing>. What worked, what didn't, what changes.",
    rounds: ["What went well.", "What went wrong or was painful.", "Concrete, owned action items."],
  },
};

export function listMeetingTemplates(): MeetingTemplate[] {
  return Object.values(TEMPLATES);
}

export function getMeetingTemplate(key: string): MeetingTemplate | undefined {
  return TEMPLATES[key];
}

export const MEETING_TEMPLATE_KEYS = Object.keys(TEMPLATES);
