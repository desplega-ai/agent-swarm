import { fileContainsOnWorker } from "../src/judge/deterministic.ts";
import type { Scenario } from "../src/types.ts";

/**
 * Heterogeneous-roster plumbing demo (v7 §9.5/§12): a LEAD on a stronger
 * model + two workers on cheaper ones, exercising every roster mechanism in
 * one cheap deterministic run —
 *   - `workers` as a WorkerSpec[] (template / name identity envs),
 *   - per-member config overrides (worker 1 + the lead run a catalog config
 *     INSTEAD of the matrix cell's config; the cell config stays the
 *     primary axis and overridden members are labeled as overrides),
 *   - a lead member (AGENT_ROLE=lead; its task is created WITHOUT agentId and
 *     the swarm API routes it to the lead — the orchestration entry point),
 *   - per-member cost/token attribution by each member's ACTUAL model.
 *
 * Models are deliberately cheap: the point is heterogeneity, not model spend.
 * Template fetches (coder/lead) are non-fatal — a registry miss just skips
 * the identity files. Deterministic-only: zero judge LLM spend. Full
 * lead-driven orchestration scenarios (the lead decomposing work itself)
 * stay backlog — this proves the plumbing.
 */
export const rosterDemo: Scenario = {
  id: "roster-demo",
  name: "Heterogeneous roster",
  description: [
    "Boots one API + a heterogeneous three-member roster: worker 0 on the matrix cell's config",
    "(with the official 'coder' template identity), worker 1 overridden to pi-deepseek-flash, and",
    "a LEAD overridden to claude-sonnet. Routes one marker-file task to each worker by index and",
    "one to the lead via agentId-less creation (the swarm routes unassigned tasks to the lead).",
    "Verifies all three side effects deterministically — proving per-member identity envs, config",
    "overrides, lead boot/routing, and per-member cost attribution in one cheap run.",
  ].join(" "),
  workers: [
    { name: "scribe-a", template: "coder" },
    { name: "scribe-b", configId: "pi-deepseek-flash" },
  ],
  lead: { name: "Lead", template: "lead", configId: "claude-sonnet" },
  tasks: [
    {
      title: "Worker A marker",
      worker: 0,
      description:
        "Create /workspace/roster-a.txt containing exactly one line:\n\nroster-a-ok\n\nThen report completion via store-progress.",
    },
    {
      title: "Worker B marker",
      worker: 1,
      description:
        "Create /workspace/roster-b.txt containing exactly one line:\n\nroster-b-ok\n\nThen report completion via store-progress.",
    },
    {
      title: "Lead marker",
      worker: "lead",
      description:
        "Create /workspace/roster-lead.txt containing exactly one line:\n\nroster-lead-ok\n\nThen report completion via store-progress.",
    },
  ],
  outcome: {
    checks: [
      fileContainsOnWorker(0, "/workspace/roster-a.txt", /roster-a-ok/),
      fileContainsOnWorker(1, "/workspace/roster-b.txt", /roster-b-ok/),
      // The lead is judge-context member index 2 (appended after the workers).
      fileContainsOnWorker(2, "/workspace/roster-lead.txt", /roster-lead-ok/),
    ],
    passThreshold: 1,
  },
  timeoutMs: 8 * 60 * 1000,
};
