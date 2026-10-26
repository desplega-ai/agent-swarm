import type { SwarmTask } from "../../src/types.ts";
import { docsSuggestion, __test__ as key } from "../docs-suggestion.ts";
import { type GraderFixture, makeContext, nullTasks } from "../grader-validation-support.ts";

/**
 * Reference: a lead that answers each setup ask with one sentence offering the
 * matching playbook, and handles the typo and the reminder without loading
 * or linking the docs.
 */

export const REFERENCE_REPLIES: Record<string, string> = {
  oncall:
    "The swarm can triage those alerts and propose fixes for a person to approve. This matches the [Open Oncall playbook](https://docs.agent-swarm.dev/docs/playbooks/open-oncall). Want me to set it up that way?",
  dora: "This matches the [DORA Metrics playbook](https://docs.agent-swarm.dev/docs/playbooks/dora-metrics). Want me to set it up that way?",
  "pr-review":
    "Yes. This matches the [PR Review playbook](https://docs.agent-swarm.dev/docs/playbooks/pr-review). Want me to set it up that way?",
  typo: "Done: README line 3 now reads 'receive'.",
  reminder: "Done: you get a one-line standup reminder every weekday at 9:00.",
};

/** Task id the null context gives a request (`task-<i>`, in REQUESTS order). */
export function taskIdFor(requestId: string): string {
  return `task-${key.REQUESTS.findIndex((r) => r.id === requestId)}`;
}

export function repliesContext(
  replies: Record<string, string>,
  logs: Record<string, Record<string, unknown>[]> = {},
) {
  const tasks = nullTasks(docsSuggestion).map((task): SwarmTask => {
    const request = key.REQUESTS.find((r) => r.title === task.title);
    return { ...task, agentId: "lead", result: replies[request?.id ?? ""] ?? "" };
  });
  return makeContext(docsSuggestion, { tasks, logs });
}

export const fixture: GraderFixture = {
  reference: () => repliesContext(REFERENCE_REPLIES),
};
