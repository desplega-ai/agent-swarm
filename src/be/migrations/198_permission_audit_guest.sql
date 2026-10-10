-- Page guest sessions are an RBAC principal, so their decisions are audited.
-- SQLite cannot change a CHECK in place, so rebuild the table with the 108
-- shape plus the new principal type. Every row is copied unchanged.

CREATE TABLE permission_audit_new (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  ts               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  principalType    TEXT NOT NULL CHECK (principalType IN ('agent','user','operator','guest')),
  principalId      TEXT,
  originatorUserId TEXT,
  verb             TEXT NOT NULL,
  resourceType     TEXT,
  resourceId       TEXT,
  decision         TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  reason           TEXT,
  source           TEXT NOT NULL CHECK (source IN ('mcp','http'))
);

INSERT INTO permission_audit_new (
  id, ts, principalType, principalId, originatorUserId,
  verb, resourceType, resourceId, decision, reason, source
)
SELECT
  id, ts, principalType, principalId, originatorUserId,
  verb, resourceType, resourceId, decision, reason, source
FROM permission_audit;

DROP TABLE permission_audit;
ALTER TABLE permission_audit_new RENAME TO permission_audit;

CREATE INDEX idx_permission_audit_ts ON permission_audit(ts);
CREATE INDEX idx_permission_audit_decision_ts ON permission_audit(decision, ts);
CREATE INDEX idx_permission_audit_principal_ts ON permission_audit(principalId, ts);
