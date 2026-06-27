-- 074_user_budget_scope.sql
-- Add per-user budget enforcement for client-side MCP users.
--
-- SQLite cannot widen a CHECK constraint in place, so recreate the affected
-- tables and preserve their data. The `budgets` table gains scope='user'.
-- `budget_refusal_notifications` gains cause='user' and optional user
-- spend/budget audit columns so claim-time user-budget refusals can share the
-- existing dedup + lead-notification rail.

CREATE TABLE budgets_new (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  daily_budget_usd REAL NOT NULL,
  createdAt INTEGER NOT NULL,
  lastUpdatedAt INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_id),
  CHECK (scope IN ('global', 'agent', 'user')),
  CHECK (daily_budget_usd >= 0)
);

INSERT INTO budgets_new (scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt)
SELECT scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt
FROM budgets;

DROP TABLE budgets;
ALTER TABLE budgets_new RENAME TO budgets;

INSERT OR IGNORE INTO budgets (scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt)
SELECT
  'user',
  id,
  dailyBudgetUsd,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM users
WHERE dailyBudgetUsd IS NOT NULL;

CREATE TABLE budget_refusal_notifications_new (
  task_id TEXT NOT NULL,
  date TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  cause TEXT NOT NULL,
  agent_spend_usd REAL,
  agent_budget_usd REAL,
  global_spend_usd REAL,
  global_budget_usd REAL,
  user_spend_usd REAL,
  user_budget_usd REAL,
  follow_up_task_id TEXT,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (task_id, date),
  CHECK (cause IN ('agent', 'global', 'user'))
);

INSERT INTO budget_refusal_notifications_new (
  task_id,
  date,
  agent_id,
  cause,
  agent_spend_usd,
  agent_budget_usd,
  global_spend_usd,
  global_budget_usd,
  user_spend_usd,
  user_budget_usd,
  follow_up_task_id,
  createdAt
)
SELECT
  task_id,
  date,
  agent_id,
  cause,
  agent_spend_usd,
  agent_budget_usd,
  global_spend_usd,
  global_budget_usd,
  NULL,
  NULL,
  follow_up_task_id,
  createdAt
FROM budget_refusal_notifications;

DROP TABLE budget_refusal_notifications;
ALTER TABLE budget_refusal_notifications_new RENAME TO budget_refusal_notifications;
