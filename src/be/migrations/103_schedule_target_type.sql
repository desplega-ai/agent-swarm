-- 103_schedule_target_type.sql
-- Add a targetType discriminator to scheduled_tasks so a schedule can natively
-- target an agent task (default, back-compat), a workflow, or a catalog script
-- — instead of the schedule→workflow link living only on the workflow side
-- (workflows.triggers[].scheduleId).

-- Step 1: Rename existing table
ALTER TABLE scheduled_tasks RENAME TO _scheduled_tasks_old;

-- Step 2: Create new table with targetType + workflow/script fields.
-- taskTemplate becomes nullable: it is not needed for workflow/script targets.
CREATE TABLE scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    cronExpression TEXT,
    intervalMs INTEGER,
    taskTemplate TEXT,
    taskType TEXT,
    tags TEXT DEFAULT '[]',
    priority INTEGER DEFAULT 50,
    targetAgentId TEXT,
    enabled INTEGER DEFAULT 1,
    lastRunAt TEXT,
    nextRunAt TEXT,
    createdByAgentId TEXT,
    timezone TEXT DEFAULT 'UTC',
    consecutiveErrors INTEGER DEFAULT 0,
    lastErrorAt TEXT,
    lastErrorMessage TEXT,
    model TEXT,
    modelTier TEXT,
    scheduleType TEXT NOT NULL DEFAULT 'recurring'
        CHECK(scheduleType IN ('recurring', 'one_time')),
    targetType TEXT NOT NULL DEFAULT 'agent-task'
        CHECK(targetType IN ('agent-task', 'workflow', 'script')),
    workflowId TEXT,
    scriptName TEXT,
    scriptArgs TEXT DEFAULT '{}',
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    created_by TEXT,
    updated_by TEXT,
    CHECK (
        (scheduleType = 'recurring' AND (cronExpression IS NOT NULL OR intervalMs IS NOT NULL))
        OR (scheduleType = 'one_time')
    ),
    CHECK (
        (targetType = 'agent-task' AND taskTemplate IS NOT NULL)
        OR (targetType = 'workflow' AND workflowId IS NOT NULL)
        OR (targetType = 'script' AND scriptName IS NOT NULL)
    )
);

-- Step 3: Copy data. Every existing row predates targetType — all are agent-task.
INSERT INTO scheduled_tasks (
    id, name, description, cronExpression, intervalMs, taskTemplate,
    taskType, tags, priority, targetAgentId, enabled, lastRunAt, nextRunAt,
    createdByAgentId, timezone, consecutiveErrors, lastErrorAt, lastErrorMessage,
    model, modelTier, scheduleType, targetType, workflowId, scriptName, scriptArgs,
    createdAt, lastUpdatedAt, created_by, updated_by
)
SELECT
    id, name, description, cronExpression, intervalMs, taskTemplate,
    taskType, tags, priority, targetAgentId, enabled, lastRunAt, nextRunAt,
    createdByAgentId, timezone, consecutiveErrors, lastErrorAt, lastErrorMessage,
    model, modelTier, scheduleType, 'agent-task', NULL, NULL, '{}',
    createdAt, lastUpdatedAt, created_by, updated_by
FROM _scheduled_tasks_old;

-- Step 4: Drop old table
DROP TABLE _scheduled_tasks_old;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_nextRunAt ON scheduled_tasks(nextRunAt);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_type ON scheduled_tasks(scheduleType);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_target_type ON scheduled_tasks(targetType);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_workflow_id ON scheduled_tasks(workflowId);
