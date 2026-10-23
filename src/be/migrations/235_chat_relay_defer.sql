-- Chat relay and defer-task (see 217_chat_sdk_state.sql for the obligation table).
--
-- 1. A deferred task posts nothing. `defer-task` completes the task with a
--    "deferred until ..." placeholder, which the terminal trigger enqueues like
--    any answer. `completeTask` writes `deferredAt` after the status, in the same
--    transaction, so this trigger drops the obligation before it commits.
-- 2. The wake-up task (`source='schedule'`, `taskType='deferred'`) keeps the
--    chat contextKey of the task it continues (src/scheduler/schedule-task.ts),
--    and relays like a chat task: it carries the real answer. The scheduler
--    grants the key only to the deferring agent continuing a task that itself
--    answered in chat; the triggers also require that the wake-up runs as the
--    same agent on the same thread as its parent.

CREATE TRIGGER drop_chat_relay_on_defer
AFTER UPDATE OF deferredAt ON agent_tasks
WHEN NEW.deferredAt IS NOT NULL AND OLD.deferredAt IS NULL
BEGIN
  DELETE FROM chat_relay_obligations
  WHERE task_id = NEW.id AND delivered_at IS NULL;
END;

-- Placeholders already queued by earlier deferrals.
DELETE FROM chat_relay_obligations
WHERE delivered_at IS NULL
  AND given_up_at IS NULL
  AND task_id IN (SELECT id FROM agent_tasks WHERE deferredAt IS NOT NULL);

DROP TRIGGER IF EXISTS enqueue_chat_relay_after_terminal_update;
DROP TRIGGER IF EXISTS enqueue_chat_relay_after_terminal_insert;

CREATE TRIGGER enqueue_chat_relay_after_terminal_update
AFTER UPDATE OF status ON agent_tasks
WHEN OLD.status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
  AND NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.contextKey GLOB 'task:chat-sdk:*'
  AND (
    NEW.source = 'chat'
    OR (NEW.source = 'system' AND NEW.taskType = 'follow-up')
    OR (
      NEW.source = 'schedule'
      AND NEW.taskType = 'deferred'
      AND EXISTS (
        SELECT 1 FROM agent_tasks parent
        WHERE parent.id = NEW.parentTaskId
          AND parent.agentId = NEW.agentId
          AND parent.contextKey = NEW.contextKey
      )
    )
    OR (
      NEW.source = 'system'
      AND NEW.taskType = 'resume'
      AND EXISTS (SELECT 1 FROM agents WHERE agents.id = NEW.agentId AND agents.isLead = 1)
    )
  )
BEGIN
  INSERT OR IGNORE INTO chat_relay_obligations (task_id)
  VALUES (NEW.id);
END;

CREATE TRIGGER enqueue_chat_relay_after_terminal_insert
AFTER INSERT ON agent_tasks
WHEN NEW.status IN ('completed', 'failed', 'cancelled')
  AND NEW.contextKey GLOB 'task:chat-sdk:*'
  AND (
    NEW.source = 'chat'
    OR (NEW.source = 'system' AND NEW.taskType = 'follow-up')
    OR (
      NEW.source = 'schedule'
      AND NEW.taskType = 'deferred'
      AND EXISTS (
        SELECT 1 FROM agent_tasks parent
        WHERE parent.id = NEW.parentTaskId
          AND parent.agentId = NEW.agentId
          AND parent.contextKey = NEW.contextKey
      )
    )
    OR (
      NEW.source = 'system'
      AND NEW.taskType = 'resume'
      AND EXISTS (SELECT 1 FROM agents WHERE agents.id = NEW.agentId AND agents.isLead = 1)
    )
  )
BEGIN
  INSERT OR IGNORE INTO chat_relay_obligations (task_id)
  VALUES (NEW.id);
END;
