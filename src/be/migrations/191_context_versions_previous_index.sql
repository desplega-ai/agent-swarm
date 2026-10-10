-- context_versions.previousVersionId is a self-referential foreign key with
-- ON DELETE SET NULL. With foreign_keys = ON, every deleted row makes SQLite
-- look up the rows that point at it. Without an index that lookup is a full
-- table scan, and because previousVersionId sits after the large `content`
-- column, each scan walks every row's overflow pages. Count-based retention
-- (CONTEXT_VERSIONS_KEEP_LATEST) deletes old versions in batches, so it needs
-- this index to keep each child lookup a single index probe.
CREATE INDEX IF NOT EXISTS idx_cv_previous_version ON context_versions(previousVersionId);
