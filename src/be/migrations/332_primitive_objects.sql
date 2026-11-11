-- Primitive objects (src/be/primitives/objects.ts): a stable id per agent-fs
-- file that backs a primitive (a board today). The file is the source of
-- truth and embeds the id, so this table is a rebuildable cache:
-- `object-reindex` restores every row from the drive.
CREATE TABLE IF NOT EXISTS primitive_objects (
  id TEXT PRIMARY KEY,
  -- Validated in code against PRIMITIVE_KINDS, so a new kind needs no migration.
  kind TEXT NOT NULL,
  orgId TEXT NOT NULL,
  driveId TEXT NOT NULL,
  -- agent-fs path, no leading slash.
  path TEXT NOT NULL,
  title TEXT,
  -- Last agent-fs version this row saw.
  fileVersion INTEGER,
  ownerAgentId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (orgId, driveId, path)
);

CREATE INDEX IF NOT EXISTS idx_primitive_objects_kind
  ON primitive_objects(orgId, driveId, kind, updatedAt);

-- deleteUser rewrites the audit columns; keep that an index search.
CREATE INDEX IF NOT EXISTS idx_primitive_objects_created_by
  ON primitive_objects(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_primitive_objects_updated_by
  ON primitive_objects(updated_by) WHERE updated_by IS NOT NULL;
