-- What incurred a cost row: a harness session, or one SystemOne decision
-- (Jev, Clef) made for a task. Task totals keep summing every row; the kind
-- lets a reader split the two without double counting.
ALTER TABLE session_costs ADD COLUMN kind TEXT NOT NULL DEFAULT 'harness';
