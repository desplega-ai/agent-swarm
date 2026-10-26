import type { SwarmTask } from "../../src/types.ts";
import { docsSuggestion, __test__ as key } from "../docs-suggestion.ts";
import { type GraderFixture, makeContext, nullTasks } from "../grader-validation-support.ts";

/**
 * Reference: a lead that answers each setup ask with one sentence offering the
 * matching playbook, and fixes the typo without linking the docs.
 */

export const REFERENCE_REPLIES: Record<string, string> = {
  oncall:
    "The swarm can triage those alerts and propose fixes for a person to approve. This matches the [Open Oncall playbook](https://docs.agent-swarm.dev/docs/playbooks/open-oncall). Want me to set it up that way?",
  dora: "This matches the [DORA Metrics playbook](https://docs.agent-swarm.dev/docs/playbooks/dora-metrics). Want me to set it up that way?",
  "pr-review":
    "Yes. This matches the [PR Review playbook](https://docs.agent-swarm.dev/docs/playbooks/pr-review). Want me to set it up that way?",
  typo: "Done: README line 3 now reads 'receive'.",
};

export function repliesContext(replies: Record<string, string>) {
  const tasks = nullTasks(docsSuggestion).map((task): SwarmTask => {
    const request = key.REQUESTS.find((r) => r.title === task.title);
    return { ...task, agentId: "lead", result: replies[request?.id ?? ""] ?? "" };
  });
  return makeContext(docsSuggestion, { tasks });
}

export const fixture: GraderFixture = {
  reference: () => repliesContext(REFERENCE_REPLIES),
};
