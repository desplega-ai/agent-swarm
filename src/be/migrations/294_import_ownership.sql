-- 294_import_ownership.sql
-- File-based imports (#2494, src/be/import).
--
-- import_items: which database row each import source owns, keyed by the
-- source-local item id. Change detection stays in seed_state (kind
-- 'import:<sourceId>:<kind>'); this table only answers "which row is mine",
-- so a same-named row the source never created is a conflict, not a target.
CREATE TABLE IF NOT EXISTS import_items (
    sourceId TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('workflow', 'skill', 'script', 'agent')),
    itemKey TEXT NOT NULL,
    entityId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (sourceId, kind, itemKey)
);

CREATE INDEX IF NOT EXISTS idx_import_items_entity ON import_items(kind, entityId);

-- import_pending_assignments: agent instructions and skill installs for an
-- agent that was not registered at import time. Applied and deleted when an
-- agent with that id or name registers; rewritten on every import of the source.
CREATE TABLE IF NOT EXISTS import_pending_assignments (
    sourceId TEXT NOT NULL,
    agentKey TEXT NOT NULL,
    agentId TEXT,
    agentName TEXT,
    instructions TEXT,
    instructionsHash TEXT,
    skillKeys TEXT NOT NULL DEFAULT '[]',
    createdAt TEXT NOT NULL,
    PRIMARY KEY (sourceId, agentKey),
    CHECK ((agentId IS NULL) <> (agentName IS NULL))
);
