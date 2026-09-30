import { expect } from "bun:test";
import { getDbClient } from "../be/db";

// The recursive CTE the usage reports rebuilt on every call before
// `agent_tasks.isHumanFree` existed. Kept as an independent oracle: the stored
// flag must select exactly the tasks this selects.
const LEGACY_HUMAN_FREE_CTE = `WITH RECURSIVE human_free_tasks(id) AS (
  SELECT task.id
  FROM agent_tasks task
  LEFT JOIN agent_tasks parent ON parent.id = task.parentTaskId
  WHERE COALESCE(task.taskType, '') IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
    OR COALESCE(task.tags, '[]') LIKE '%"heartbeat"%'
    OR (COALESCE(task.source, '') = 'schedule' AND task.requestedByUserId IS NULL)
    OR (
      task.parentTaskId IS NULL
      AND COALESCE(task.source, '') = 'workflow'
      AND task.requestedByUserId IS NULL
      AND EXISTS (
        SELECT 1 FROM workflow_runs run
        WHERE run.id = task.workflowRunId
          AND run.triggerType = 'schedule'
          AND run.created_by IS NULL
      )
    )
    OR (
      COALESCE(task.source, '') = 'system'
      AND parent.id IS NOT NULL
      AND parent.requestedByUserId IS NULL
    )
  UNION
  SELECT child.id
  FROM agent_tasks child
  JOIN human_free_tasks parent ON child.parentTaskId = parent.id
  WHERE child.requestedByUserId IS NULL
    OR child.requestedByUserIdInherited = 1
)`;

export async function storedFlags(): Promise<Map<string, boolean>> {
  const rows = await getDbClient().query<{ id: string; isHumanFree: number }>(
    "SELECT id, isHumanFree FROM agent_tasks",
  );
  return new Map(rows.map((row) => [row.id, row.isHumanFree === 1]));
}

export async function legacyHumanFreeIds(): Promise<Set<string>> {
  const rows = await getDbClient().query<{ id: string }>(
    `${LEGACY_HUMAN_FREE_CTE} SELECT id FROM human_free_tasks`,
  );
  return new Set(rows.map((row) => row.id));
}

export function expectFlagsMatchLegacy(flags: Map<string, boolean>, legacy: Set<string>) {
  const mismatched = [...flags]
    .filter(([id, flagged]) => flagged !== legacy.has(id))
    .map(([id, flagged]) => `${id} stored=${flagged} legacy=${legacy.has(id)}`);
  expect(mismatched).toEqual([]);
}
