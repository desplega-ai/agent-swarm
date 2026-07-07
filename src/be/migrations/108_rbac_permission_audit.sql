-- RBAC permission-audit trail (DES-445, slice 1 / increment 2).
-- One row per can() authorization decision — allow AND deny — written by the
-- async batched writer in src/be/rbac-audit.ts. Answers "which permission was
-- missing, at which layer" without grepping logs. Rows are structured
-- ids/verbs only (no payloads); retention GC purges rows older than
-- RBAC_AUDIT_RETENTION_DAYS (default 30).
-- originatorUserId is reserved for originating-user propagation (later
-- increment); the slice-1 RbacCheck does not carry it yet.

CREATE TABLE IF NOT EXISTS permission_audit (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  ts               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  principalType    TEXT NOT NULL CHECK (principalType IN ('agent','user','operator')),
  principalId      TEXT,
  originatorUserId TEXT,
  verb             TEXT NOT NULL,
  resourceType     TEXT,
  resourceId       TEXT,
  decision         TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  reason           TEXT,
  source           TEXT NOT NULL CHECK (source IN ('mcp','http'))
);

CREATE INDEX IF NOT EXISTS idx_permission_audit_ts ON permission_audit(ts);
CREATE INDEX IF NOT EXISTS idx_permission_audit_decision_ts ON permission_audit(decision, ts);
CREATE INDEX IF NOT EXISTS idx_permission_audit_principal_ts ON permission_audit(principalId, ts);
