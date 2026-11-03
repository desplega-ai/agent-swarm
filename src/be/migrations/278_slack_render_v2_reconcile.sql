-- Cut the Slack render-v2 reconcile cost. bun:sqlite is synchronous, so each
-- discovery query in the 3 s render tick blocks the event loop for its full
-- run. All three scanned the whole render-v2 history on every tick.

-- Deferral resolution anchors on the few tasks that ever deferred instead of
-- on every outcome card.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_deferred
  ON agent_tasks(id)
  WHERE deferredAt IS NOT NULL;

-- The missing-tree sweep is bounded to recent Slack tasks; this makes the
-- createdAt bound a range seek instead of a filter over every Slack task.
CREATE INDEX IF NOT EXISTS idx_agent_tasks_slack_created
  ON agent_tasks(createdAt)
  WHERE source = 'slack' AND slackChannelId IS NOT NULL AND slackThreadTs IS NOT NULL;

-- A tree is closed once the tree sweep has nothing left to do for it. The
-- sweep reads only open trees. Any write that could give the thread work
-- again (a task in the thread, an outcome card in the thread) reopens it
-- through the triggers below, so "closed" stays a pure cache of "the sweep
-- would skip it".
ALTER TABLE slack_messages ADD COLUMN closed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_slack_messages_open_trees
  ON slack_messages(created_at)
  WHERE kind = 'tree' AND closed_at IS NULL;

-- Backfill: close every tree the sweep (getSlackTreeMessages) skips today.
-- Keep this predicate in step with SLACK_TREE_NEEDS_RENDER_SQL in src/be/db.ts.
UPDATE slack_messages AS tree
   SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE tree.kind = 'tree'
   AND tree.closed_at IS NULL
   AND tree.ts NOT LIKE 'pending:%'
   AND EXISTS (SELECT 1 FROM slack_render_v2_state WHERE id = 1)
   AND NOT EXISTS (
     SELECT 1 FROM agent_tasks task, slack_render_v2_state state
      WHERE state.id = 1
        AND task.slackChannelId = tree.channel_id
        AND task.slackThreadTs = tree.thread_ts
        AND task.createdAt >= state.activated_at
        AND (
          (task.source = 'slack'
            AND task.status IN ('completed', 'failed', 'cancelled')
            AND NOT EXISTS (
              SELECT 1 FROM slack_messages outcome
               WHERE outcome.kind = 'outcome'
                 AND outcome.task_id = task.id
                 AND (outcome.finalized_at IS NOT NULL OR outcome.delivery_abandoned_at IS NOT NULL)
            ))
          OR task.status NOT IN ('completed', 'failed', 'cancelled', 'superseded', 'skipped')
          OR task.lastUpdatedAt > tree.updated_at
        )
   )
   AND NOT EXISTS (
     SELECT 1 FROM slack_messages outcome
       JOIN agent_tasks task ON task.id = outcome.task_id,
       slack_render_v2_state state
      WHERE state.id = 1
        AND outcome.kind = 'outcome'
        AND outcome.channel_id = tree.channel_id
        AND outcome.thread_ts = tree.thread_ts
        AND task.createdAt >= state.activated_at
        AND (
          (outcome.finalized_at IS NULL AND outcome.delivery_abandoned_at IS NULL)
          OR outcome.updated_at > tree.updated_at
        )
   );

-- Reopen: a task in the thread was created or changed.
CREATE TRIGGER reopen_slack_tree_after_task_insert
AFTER INSERT ON agent_tasks
WHEN NEW.slackChannelId IS NOT NULL AND NEW.slackThreadTs IS NOT NULL
BEGIN
  UPDATE slack_messages SET closed_at = NULL
   WHERE kind = 'tree'
     AND channel_id = NEW.slackChannelId
     AND thread_ts = NEW.slackThreadTs
     AND closed_at IS NOT NULL;
END;

CREATE TRIGGER reopen_slack_tree_after_task_update
AFTER UPDATE OF status, lastUpdatedAt, slackChannelId, slackThreadTs ON agent_tasks
WHEN NEW.slackChannelId IS NOT NULL AND NEW.slackThreadTs IS NOT NULL
BEGIN
  UPDATE slack_messages SET closed_at = NULL
   WHERE kind = 'tree'
     AND channel_id = NEW.slackChannelId
     AND thread_ts = NEW.slackThreadTs
     AND closed_at IS NOT NULL;
END;

-- Reopen: an outcome card in the thread was created or changed.
CREATE TRIGGER reopen_slack_tree_after_outcome_insert
AFTER INSERT ON slack_messages
WHEN NEW.kind = 'outcome'
BEGIN
  UPDATE slack_messages SET closed_at = NULL
   WHERE kind = 'tree'
     AND channel_id = NEW.channel_id
     AND thread_ts = NEW.thread_ts
     AND closed_at IS NOT NULL;
END;

CREATE TRIGGER reopen_slack_tree_after_outcome_update
AFTER UPDATE ON slack_messages
WHEN NEW.kind = 'outcome'
BEGIN
  UPDATE slack_messages SET closed_at = NULL
   WHERE kind = 'tree'
     AND channel_id = NEW.channel_id
     AND thread_ts = NEW.thread_ts
     AND closed_at IS NOT NULL;
END;
