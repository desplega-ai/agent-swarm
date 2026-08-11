-- DevFlow bounded-context foundation: tenant isolation, lifecycle artifacts,
-- structured agent evidence, gate decisions, and append-only audit history.

CREATE TABLE devflow_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  settingsJson TEXT NOT NULL DEFAULT '{}',
  isActive INTEGER NOT NULL DEFAULT 1 CHECK (isActive IN (0, 1)),
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);

CREATE TABLE devflow_organization_memberships (
  organizationId TEXT NOT NULL REFERENCES devflow_organizations(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN (
    'admin', 'pm_director', 'pm', 'engineering_lead', 'architect',
    'senior_developer', 'execution_lead', 'qa', 'viewer'
  )),
  isActive INTEGER NOT NULL DEFAULT 1 CHECK (isActive IN (0, 1)),
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  PRIMARY KEY (organizationId, userId)
);
CREATE INDEX idx_devflow_memberships_user ON devflow_organization_memberships(userId, isActive);

CREATE TABLE devflow_work_items (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES devflow_organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'idea' CHECK (type IN ('idea','feature','bug','task','architecture','ops')),
  state TEXT NOT NULL DEFAULT 'captured' CHECK (state IN (
    'captured','triaged','scoped','specced','sized','planned','building',
    'in_review','deployed','monitoring','done','blocked','archived'
  )),
  previousState TEXT,
  blockerReason TEXT,
  archiveReason TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT CHECK (priority IS NULL OR priority IN ('p1','p2','p3')),
  storyPoints INTEGER,
  sprintId TEXT,
  sprintProbability REAL,
  blastRadius TEXT CHECK (blastRadius IS NULL OR blastRadius IN ('low','medium','high')),
  isSecuritySensitive INTEGER NOT NULL DEFAULT 0 CHECK (isSecuritySensitive IN (0, 1)),
  duplicateOf TEXT,
  duplicateConfidence REAL,
  classificationRationale TEXT,
  pmOwnerId TEXT NOT NULL REFERENCES users(id),
  engineeringOwnerId TEXT REFERENCES users(id),
  assignedToUserId TEXT REFERENCES users(id),
  createdVia TEXT NOT NULL CHECK (createdVia IN ('manual','slack','fathom','github','email','api')),
  sourceMetadataJson TEXT NOT NULL DEFAULT '{}',
  capturedAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (id, organizationId)
);
CREATE INDEX idx_devflow_work_items_org_state ON devflow_work_items(organizationId, state, lastUpdatedAt DESC);
CREATE INDEX idx_devflow_work_items_org_type ON devflow_work_items(organizationId, type);

CREATE TABLE devflow_scopes (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  workItemId TEXT NOT NULL,
  problemStatement TEXT NOT NULL,
  targetUsersJson TEXT NOT NULL,
  successCriteriaJson TEXT NOT NULL,
  effortBand TEXT NOT NULL CHECK (effortBand IN ('xs','s','m','l','xl')),
  openQuestionsJson TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  rationale TEXT NOT NULL DEFAULT '',
  agentRunId TEXT,
  pmSignedOffAt TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (organizationId, workItemId),
  FOREIGN KEY (workItemId, organizationId) REFERENCES devflow_work_items(id, organizationId) ON DELETE CASCADE
);

CREATE TABLE devflow_specs (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  workItemId TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  problemStatement TEXT NOT NULL,
  userStories TEXT NOT NULL DEFAULT '',
  outOfScope TEXT NOT NULL DEFAULT '',
  uxBehavior TEXT NOT NULL,
  dataModelChanges TEXT NOT NULL,
  integrationPoints TEXT NOT NULL,
  threatModel TEXT,
  rollbackPlan TEXT,
  dependencyMapJson TEXT NOT NULL DEFAULT '[]',
  openQuestionsJson TEXT NOT NULL DEFAULT '[]',
  draftedByAgentRunId TEXT,
  approvedAt TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (workItemId, version),
  UNIQUE (id, organizationId),
  FOREIGN KEY (workItemId, organizationId) REFERENCES devflow_work_items(id, organizationId) ON DELETE CASCADE
);
CREATE INDEX idx_devflow_specs_current ON devflow_specs(organizationId, workItemId, version DESC);

CREATE TABLE devflow_acceptance_criteria (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  specId TEXT NOT NULL,
  givenText TEXT NOT NULL,
  whenText TEXT NOT NULL,
  thenText TEXT NOT NULL,
  isTestable INTEGER NOT NULL CHECK (isTestable IN (0, 1)),
  testHint TEXT NOT NULL DEFAULT '',
  testStatus TEXT NOT NULL DEFAULT 'unverified' CHECK (testStatus IN ('unverified','passing','failing','skipped')),
  linkedTestId TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  FOREIGN KEY (specId, organizationId) REFERENCES devflow_specs(id, organizationId) ON DELETE CASCADE
);
CREATE INDEX idx_devflow_ac_spec ON devflow_acceptance_criteria(organizationId, specId);

CREATE TABLE devflow_nfr_declarations (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  specId TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'supportability','testability','security','scalability','usability',
    'maintainability','reliability','observability','performance'
  )),
  status TEXT NOT NULL CHECK (status IN ('addressed','not_applicable','pending')),
  statement TEXT NOT NULL DEFAULT '',
  reviewedAt TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (specId, category),
  FOREIGN KEY (specId, organizationId) REFERENCES devflow_specs(id, organizationId) ON DELETE CASCADE
);

CREATE TABLE devflow_gate_decisions (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  workItemId TEXT NOT NULL,
  gate INTEGER NOT NULL CHECK (gate BETWEEN 1 AND 5),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','timeout')),
  actorUserId TEXT NOT NULL REFERENCES users(id),
  actorRole TEXT NOT NULL,
  rationale TEXT NOT NULL,
  preconditionSnapshotJson TEXT NOT NULL,
  approvalRequestId TEXT REFERENCES approval_requests(id),
  decidedAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  FOREIGN KEY (workItemId, organizationId) REFERENCES devflow_work_items(id, organizationId) ON DELETE CASCADE
);
CREATE INDEX idx_devflow_gate_item ON devflow_gate_decisions(organizationId, workItemId, decidedAt DESC);

CREATE TABLE devflow_agent_runs (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  workItemId TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('intake','scope','spec')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','timed_out')),
  swarmTaskId TEXT REFERENCES agent_tasks(id),
  workflowRunId TEXT REFERENCES workflow_runs(id),
  contractVersion TEXT NOT NULL,
  promptVersion TEXT NOT NULL,
  evidenceJson TEXT,
  evidenceAppliedAt TEXT,
  latencyMs INTEGER,
  costUsd REAL,
  errorMessage TEXT,
  startedAt TEXT,
  finishedAt TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  FOREIGN KEY (workItemId, organizationId) REFERENCES devflow_work_items(id, organizationId) ON DELETE CASCADE
);
CREATE INDEX idx_devflow_agent_runs_item ON devflow_agent_runs(organizationId, workItemId, createdAt DESC);

CREATE TABLE devflow_audit_events (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES devflow_organizations(id) ON DELETE CASCADE,
  workItemId TEXT,
  actorKind TEXT NOT NULL CHECK (actorKind IN ('user','agent','system')),
  actorId TEXT,
  action TEXT NOT NULL,
  beforeState TEXT,
  afterState TEXT,
  metadataJson TEXT NOT NULL DEFAULT '{}',
  correlationId TEXT,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (workItemId, organizationId) REFERENCES devflow_work_items(id, organizationId) ON DELETE CASCADE
);
CREATE INDEX idx_devflow_audit_org_time ON devflow_audit_events(organizationId, createdAt DESC);
CREATE INDEX idx_devflow_audit_item_time ON devflow_audit_events(organizationId, workItemId, createdAt DESC);
