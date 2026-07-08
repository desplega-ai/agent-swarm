-- RBAC role engine storage (DES-445, increment 3).
-- Defines durable role grants for authenticated user admission. See the design
-- note at thoughts/taras/plans/2026-07-07-des-445-rbac-user-policy-admission-model.md.
--
-- Trigger fragility: trg_users_default_role depends on the users table. SQLite
-- silently drops triggers when a table is rebuilt with the create/copy/drop/
-- rename pattern, so any future users-table rebuild must recreate this trigger.
-- Phase 2's ensureRbacSeedsSynced boot path intentionally self-heals it as a
-- backstop, but migrations that rebuild users should still recreate it directly.
-- Built-in seed conflicts are surfaced by ensureRbacSeedsSynced at boot; that
-- is fatal when RBAC_ENABLED=true and logged/continued when the flag is off.

CREATE TABLE IF NOT EXISTS roles (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name          TEXT NOT NULL UNIQUE,
  description   TEXT,
  isBuiltin     INTEGER NOT NULL DEFAULT 0,
  grantsAll     INTEGER NOT NULL DEFAULT 0,
  createdAt     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lastUpdatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Future role-management API populates audit users; system writers leave NULL.
  created_by    TEXT REFERENCES users(id),
  updated_by    TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  roleId    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  verb      TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Future role-management API populates audit users; system writers leave NULL.
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  PRIMARY KEY (roleId, verb)
);

CREATE TABLE IF NOT EXISTS principal_roles (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  principalType TEXT NOT NULL CHECK (principalType IN ('user','agent')),
  principalId   TEXT NOT NULL,
  roleId        TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  createdAt     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Future role-management API populates audit users; system writers leave NULL.
  created_by    TEXT REFERENCES users(id),
  updated_by    TEXT REFERENCES users(id),
  UNIQUE (principalType, principalId, roleId)
);
CREATE INDEX IF NOT EXISTS idx_principal_roles_principal
  ON principal_roles(principalType, principalId);

-- Built-in roles: fixed ids so trigger/backfill SQL and code can reference them.
INSERT OR IGNORE INTO roles (id, name, description, isBuiltin, grantsAll) VALUES
  ('rbac-role-admin', 'admin',
   'Full access including verb-less routes (legacy-equivalent default).', 1, 1),
  ('rbac-role-requester', 'requester',
   'Own-task lifecycle: what legacy policy grants user principals.', 1, 0);

-- Initial snapshot of the requester verb-set; code (BUILTIN_ROLES in
-- src/be/rbac-roles.ts) is authoritative and re-syncs at boot.
INSERT OR IGNORE INTO role_permissions (roleId, verb) VALUES
  ('rbac-role-requester', 'task.read.own'),
  ('rbac-role-requester', 'task.cancel.own'),
  ('rbac-role-requester', 'task.action.own'),
  ('rbac-role-requester', 'task.fs.mutate');

-- Backfill: every existing user holds the default role.
INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId)
  SELECT 'user', id, 'rbac-role-admin'
  FROM users
  WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'rbac-role-admin');

-- Every future user row (createUser, findOrCreateUserByEmail, raw test
-- INSERTs) gets the default role atomically.
CREATE TRIGGER IF NOT EXISTS trg_users_default_role
AFTER INSERT ON users
BEGIN
  INSERT OR IGNORE INTO principal_roles (principalType, principalId, roleId)
  SELECT 'user', NEW.id, 'rbac-role-admin'
  WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'rbac-role-admin');
END;
