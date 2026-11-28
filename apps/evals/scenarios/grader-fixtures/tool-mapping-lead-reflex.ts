import {
  type GraderFixture,
  makeContext,
  nullTasks,
  toolCallRows,
} from "../grader-validation-support.ts";
import { toolMappingLeadReflex } from "../tool-mapping-lead-reflex.ts";

/**
 * Reference: the lead dispatches one swarm task per service to the two checkers
 * with `send-task`, never calls a native spawn tool, and merges the reported
 * values (alpha: port 7311, owner team-kestrel; beta: port 7422, owner
 * team-osprey). The null agent completes the lead task with no output, so the
 * `lead-reported` gate fails. Roster: worker-0, worker-1, lead.
 */

const LEAD = "lead";
const ALPHA = "alpha: port 7311, owner team-kestrel";
const BETA = "beta: port 7422, owner team-osprey";

const [seedTask] = nullTasks(toolMappingLeadReflex);

function child(id: string, worker: string, result: string) {
  return {
    id,
    title: `Check one service`,
    description: "Read services/<service>/service.toml and report port and owner.",
    status: "completed",
    agentId: worker,
    creatorAgentId: LEAD,
    parentTaskId: "task-0",
    result,
    origin: "run" as const,
  };
}

export const fixture: GraderFixture = {
  reference: () =>
    makeContext(toolMappingLeadReflex, {
      tasks: [
        {
          ...(seedTask as NonNullable<typeof seedTask>),
          agentId: LEAD,
          result: `Both checks are back.\n${ALPHA}\n${BETA}`,
        },
        child("child-alpha", "worker-0", "service alpha: port = 7311, owner = team-kestrel"),
        child("child-beta", "worker-1", "service beta: port = 7422, owner = team-osprey"),
      ],
      logs: {
        "task-0": [
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__send-task",
            { task: "Check service alpha", agentId: "worker-0" },
            { success: true, task: { id: "child-alpha" } },
            "toolu_send_alpha",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__send-task",
            { task: "Check service beta", agentId: "worker-1" },
            { success: true, task: { id: "child-beta" } },
            "toolu_send_beta",
          ),
        ],
      },
    }),
};
