-- Dashboard favorites become per user. The dashboard authenticates with the
-- shared operator key, so until now every dashboard toggle landed in the one
-- 'operator' scope and everyone saw the same stars. The dashboard now names
-- its picked user (X-Swarm-User-Id) and favorites are stored under
-- 'user:<id>'.
--
-- Existing rows are kept. Each 'operator' favorite is copied to every active
-- user, so nobody loses a star they saw before; from here on each user's set
-- changes on its own. The 'operator' rows stay as the set for dashboard tabs
-- with no picked user. Rows already scoped to a user are untouched.

INSERT OR IGNORE INTO user_favorites (
  favoriteScope, userId, itemType, itemId,
  createdAt, lastUpdatedAt, created_by, updated_by
)
SELECT
  'user:' || u.id, u.id, f.itemType, f.itemId,
  f.createdAt, f.lastUpdatedAt, f.created_by, f.updated_by
FROM user_favorites f
CROSS JOIN users u
WHERE f.favoriteScope = 'operator'
  AND u.status = 'active';

-- Deleting a workflow or schedule left its favorites behind (no FK). The
-- delete paths now clean them; drop the rows already orphaned.
DELETE FROM user_favorites
WHERE (itemType = 'workflow' AND itemId NOT IN (SELECT id FROM workflows))
   OR (itemType = 'schedule' AND itemId NOT IN (SELECT id FROM scheduled_tasks))
   OR (itemType = 'page' AND itemId NOT IN (SELECT id FROM pages));
