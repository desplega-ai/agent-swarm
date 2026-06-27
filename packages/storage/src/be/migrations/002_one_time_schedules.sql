-- 002_one_time_schedules.sql
-- Add scheduleType column to scheduled_tasks and relax CHECK constraint
-- to allow one-time schedules without cronExpression or intervalMs.

-- Step 1: Rename existing table
ALTER TABLE scheduled_tasks RENAME TO _scheduled_tasks_old;

-- Step 2: Create new table with scheduleType and updated constraints
CREATE TABLE scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    cronExpression TEXT,
    intervalMs INTEGER,
    taskTemplate TEXT NOT NULL,
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
    scheduleType TEXT NOT NULL DEFAULT 'recurring' CHECK(scheduleType IN ('recurring', 'one_time')),
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    CHECK (
        (scheduleType = 'recurring' AND (cronExpression IS NOT NULL OR intervalMs IS NOT NULL))
        OR
        (scheduleType = 'one_time')
    )
);

-- Step 3: Copy data with explicit columns (all existing schedules are 'recurring')
INSERT INTO scheduled_tasks (
    id, name, description, cronExpression, intervalMs, taskTemplate,
    taskType, tags, priority, targetAgentId, enabled, lastRunAt, nextRunAt,
    createdByAgentId, timezone, consecutiveErrors, lastErrorAt, lastErrorMessage,
    model, scheduleType, createdAt, lastUpdatedAt
)
SELECT
    id, name, description, cronExpression, intervalMs, taskTemplate,
    taskType, tags, priority, targetAgentId, enabled, lastRunAt, nextRunAt,
    createdByAgentId, timezone, consecutiveErrors, lastErrorAt, lastErrorMessage,
    model, 'recurring', createdAt, lastUpdatedAt
FROM _scheduled_tasks_old;

-- Step 4: Drop old table
DROP TABLE _scheduled_tasks_old;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_nextRunAt ON scheduled_tasks(nextRunAt);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_type ON scheduled_tasks(scheduleType);
