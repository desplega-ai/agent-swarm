import {
  type GraderFixture,
  makeContext,
  nullTasks,
  toolCallRows,
} from "../grader-validation-support.ts";
import { toolMappingWorkerLocal } from "../tool-mapping-worker-local.ts";

/**
 * Reference: the worker reads the three files itself (a native subagent would be
 * fine too) and answers total 46, top "south". It creates no swarm task. The
 * null agent completes with no output, so the `answer-json` gate fails.
 */
export const fixture: GraderFixture = {
  reference: () =>
    makeContext(toolMappingWorkerLocal, {
      tasks: nullTasks(toolMappingWorkerLocal).map((t) => ({
        ...t,
        agentId: "worker-0",
        result: '{"total": 46, "top": "south"}',
      })),
      logs: {
        "task-0": ["north", "south", "east"].flatMap((file) =>
          toolCallRows(
            "task-0",
            "Read",
            { file_path: `/workspace/inventory/${file}.csv` },
            "item,quantity",
            `toolu_read_${file}`,
          ),
        ),
      },
    }),
};
