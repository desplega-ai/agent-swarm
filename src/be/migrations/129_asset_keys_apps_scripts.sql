-- Extend canonical asset namespaces to apps and scripts.

ALTER TABLE apps ADD COLUMN "key" TEXT NOT NULL DEFAULT 'shared/';
ALTER TABLE scripts ADD COLUMN "key" TEXT NOT NULL DEFAULT 'shared/';

UPDATE apps SET "key" = 'shared/' WHERE "key" IS NULL OR trim("key") = '';
UPDATE scripts SET "key" = 'shared/' WHERE "key" IS NULL OR trim("key") = '';

CREATE INDEX idx_apps_asset_key ON apps("key");
CREATE INDEX idx_scripts_asset_key ON scripts("key");

-- SQLite cannot widen a CHECK constraint in place. Rebuild the append-only
-- history table with app and script added to the existing entity-type set.
CREATE TABLE asset_key_history_new (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('task', 'workflow', 'schedule', 'page', 'app', 'script', 'file')),
  entity_id    TEXT NOT NULL,
  previous_key TEXT,
  new_key      TEXT NOT NULL,
  changed_by   TEXT REFERENCES users(id),
  changed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO asset_key_history_new (
  id,
  entity_type,
  entity_id,
  previous_key,
  new_key,
  changed_by,
  changed_at
)
SELECT
  id,
  entity_type,
  entity_id,
  previous_key,
  new_key,
  changed_by,
  changed_at
FROM asset_key_history;

DROP TABLE asset_key_history;
ALTER TABLE asset_key_history_new RENAME TO asset_key_history;

CREATE INDEX idx_asset_key_history_entity
  ON asset_key_history(entity_type, entity_id, changed_at DESC);

-- Keep these bodies byte-for-byte aligned with migration 115's entity-table
-- triggers. SQLite cannot express the remaining NFKC rule.
CREATE TRIGGER validate_apps_asset_key_insert
BEFORE INSERT ON apps
WHEN NEW."key" IS NULL
  OR length(NEW."key") = 0
  OR NEW."key" != trim(NEW."key")
  OR length(NEW."key") > 255
  OR substr(NEW."key", -1, 1) != '/'
  OR instr(NEW."key", char(0)) > 0
  OR instr(NEW."key", char(92)) > 0
  OR instr(NEW."key", '//') > 0
  OR instr(NEW."key", '/../') > 0
  OR instr(NEW."key", '/./') > 0
  OR NEW."key" != lower(NEW."key")
  OR NOT (
    NEW."key" = 'shared/'
    OR NEW."key" LIKE 'shared/%'
    OR (
      NEW."key" LIKE 'personal/%/%'
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = substr(NEW."key", 10, instr(substr(NEW."key", 10), '/') - 1)
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid asset namespace key');
END;

CREATE TRIGGER validate_apps_asset_key_update
BEFORE UPDATE OF "key" ON apps
WHEN NEW."key" IS NULL
  OR length(NEW."key") = 0
  OR NEW."key" != trim(NEW."key")
  OR length(NEW."key") > 255
  OR substr(NEW."key", -1, 1) != '/'
  OR instr(NEW."key", char(0)) > 0
  OR instr(NEW."key", char(92)) > 0
  OR instr(NEW."key", '//') > 0
  OR instr(NEW."key", '/../') > 0
  OR instr(NEW."key", '/./') > 0
  OR NEW."key" != lower(NEW."key")
  OR NOT (
    NEW."key" = 'shared/'
    OR NEW."key" LIKE 'shared/%'
    OR (
      NEW."key" LIKE 'personal/%/%'
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = substr(NEW."key", 10, instr(substr(NEW."key", 10), '/') - 1)
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid asset namespace key');
END;

CREATE TRIGGER validate_scripts_asset_key_insert
BEFORE INSERT ON scripts
WHEN NEW."key" IS NULL
  OR length(NEW."key") = 0
  OR NEW."key" != trim(NEW."key")
  OR length(NEW."key") > 255
  OR substr(NEW."key", -1, 1) != '/'
  OR instr(NEW."key", char(0)) > 0
  OR instr(NEW."key", char(92)) > 0
  OR instr(NEW."key", '//') > 0
  OR instr(NEW."key", '/../') > 0
  OR instr(NEW."key", '/./') > 0
  OR NEW."key" != lower(NEW."key")
  OR NOT (
    NEW."key" = 'shared/'
    OR NEW."key" LIKE 'shared/%'
    OR (
      NEW."key" LIKE 'personal/%/%'
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = substr(NEW."key", 10, instr(substr(NEW."key", 10), '/') - 1)
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid asset namespace key');
END;

CREATE TRIGGER validate_scripts_asset_key_update
BEFORE UPDATE OF "key" ON scripts
WHEN NEW."key" IS NULL
  OR length(NEW."key") = 0
  OR NEW."key" != trim(NEW."key")
  OR length(NEW."key") > 255
  OR substr(NEW."key", -1, 1) != '/'
  OR instr(NEW."key", char(0)) > 0
  OR instr(NEW."key", char(92)) > 0
  OR instr(NEW."key", '//') > 0
  OR instr(NEW."key", '/../') > 0
  OR instr(NEW."key", '/./') > 0
  OR NEW."key" != lower(NEW."key")
  OR NOT (
    NEW."key" = 'shared/'
    OR NEW."key" LIKE 'shared/%'
    OR (
      NEW."key" LIKE 'personal/%/%'
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = substr(NEW."key", 10, instr(substr(NEW."key", 10), '/') - 1)
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid asset namespace key');
END;
