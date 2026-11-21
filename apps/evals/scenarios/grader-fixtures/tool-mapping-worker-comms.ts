import {
  type GraderFixture,
  makeContext,
  nullTasks,
  toolCallRows,
} from "../grader-validation-support.ts";
import { toolMappingWorkerComms } from "../tool-mapping-worker-comms.ts";

/**
 * Reference: worker A (worker-0) creates T for worker B (worker-1), steers T to
 * b.txt with `steer-task`, waits with the `wait-for-task` script and reports
 * T's corrected marker (BLUE-6604). No native messaging, no second task. The
 * null agent completes with no output, so the `marker-reported` gate fails.
 */

const T = "child-t";

export const fixture: GraderFixture = {
  reference: () =>
    makeContext(toolMappingWorkerComms, {
      tasks: [
        ...nullTasks(toolMappingWorkerComms).map((t) => ({
          ...t,
          agentId: "worker-0",
          result: "worker-b finished the corrected task.\nmarker: BLUE-6604",
        })),
        {
          id: T,
          title: "Read the marker",
          description:
            "Run sleep 90, then read /workspace/comms/a.txt and reply with its marker line.",
          status: "completed",
          agentId: "worker-1",
          creatorAgentId: "worker-0",
          result: "marker: BLUE-6604",
          origin: "run" as const,
        },
      ],
      logs: {
        "task-0": [
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__send-task",
            { task: "Run sleep 90, then read a.txt", agentId: "worker-1" },
            { success: true, task: { id: T } },
            "toolu_send",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__steer-task",
            { taskId: T, message: "Read /workspace/comms/b.txt instead of a.txt." },
            { success: true },
            "toolu_steer",
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__script-run",
            { name: "wait-for-task", scope: "global", args: { taskId: T } },
            { status: "completed" },
            "toolu_wait",
          ),
        ],
      },
    }),
};
