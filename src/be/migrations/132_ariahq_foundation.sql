-- AriaHQ platform foundation: governed engine authoring, authoritative knowledge,
-- Slack trust surfaces, and client-safe DevFlow intake projections.

CREATE TABLE ariahq_engine_drafts (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES devflow_organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed')),
  swarmTaskId TEXT REFERENCES agent_tasks(id),
  proposedContractJson TEXT,
  errorMessage TEXT,
  createdByUserId TEXT NOT NULL REFERENCES users(id),
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (id, organizationId)
);
CREATE INDEX idx_ariahq_engine_drafts_org_status
  ON ariahq_engine_drafts(organizationId, status, lastUpdatedAt DESC);

CREATE TABLE ariahq_engine_versions (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES devflow_organizations(id) ON DELETE CASCADE,
  draftId TEXT NOT NULL,
  engineKey TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','retired')),
  contractJson TEXT NOT NULL,
  workflowId TEXT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  publishedByUserId TEXT NOT NULL REFERENCES users(id),
  publishedAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (id, organizationId),
  UNIQUE (organizationId, draftId),
  UNIQUE (organizationId, engineKey, version),
  FOREIGN KEY (draftId, organizationId)
    REFERENCES ariahq_engine_drafts(id, organizationId) ON DELETE RESTRICT
);
CREATE INDEX idx_ariahq_engine_versions_org_key
  ON ariahq_engine_versions(organizationId, engineKey, version DESC);

CREATE TABLE ariahq_knowledge_records (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES devflow_organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('source_evidence','canonical_fact','derived_insight')),
  sourceKind TEXT NOT NULL CHECK (sourceKind IN (
    'slack','google_drive','call_recording','crm','github','manual','ariahq'
  )),
  sourceRef TEXT NOT NULL,
  sourceRevision TEXT NOT NULL,
  sourceUrl TEXT,
  audience TEXT NOT NULL CHECK (audience IN ('internal','client')),
  clientKey TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  verificationStatus TEXT NOT NULL CHECK (verificationStatus IN (
    'raw','verified','conflicted','superseded'
  )),
  effectiveAt TEXT NOT NULL,
  expiresAt TEXT,
  checksum TEXT NOT NULL,
  metadataJson TEXT NOT NULL DEFAULT '{}',
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  CHECK (
    (audience = 'internal' AND clientKey IS NULL) OR
    (audience = 'client' AND clientKey IS NOT NULL AND length(clientKey) > 0)
  ),
  UNIQUE (id, organizationId),
  UNIQUE (organizationId, sourceKind, sourceRef, sourceRevision)
);
CREATE INDEX idx_ariahq_knowledge_org_audience
  ON ariahq_knowledge_records(organizationId, audience, clientKey, effectiveAt DESC);
CREATE INDEX idx_ariahq_knowledge_source
  ON ariahq_knowledge_records(organizationId, sourceKind, sourceRef);

CREATE TABLE ariahq_slack_surfaces (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES devflow_organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  channelId TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('internal','client')),
  clientKey TEXT,
  captureMode TEXT NOT NULL CHECK (captureMode IN ('mention_only','designated_channel')),
  pmOwnerId TEXT NOT NULL REFERENCES users(id),
  isActive INTEGER NOT NULL DEFAULT 1 CHECK (isActive IN (0,1)),
  createdByUserId TEXT NOT NULL REFERENCES users(id),
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  CHECK (
    (audience = 'internal' AND clientKey IS NULL) OR
    (audience = 'client' AND clientKey IS NOT NULL AND length(clientKey) > 0)
  ),
  UNIQUE (id, organizationId),
  UNIQUE (workspaceId, channelId)
);
CREATE INDEX idx_ariahq_slack_surfaces_org
  ON ariahq_slack_surfaces(organizationId, audience, isActive);

CREATE TABLE ariahq_client_intakes (
  id TEXT PRIMARY KEY,
  organizationId TEXT NOT NULL,
  slackSurfaceId TEXT NOT NULL,
  workItemId TEXT NOT NULL,
  messageTs TEXT NOT NULL,
  threadTs TEXT NOT NULL,
  externalUserId TEXT NOT NULL,
  clientStatus TEXT NOT NULL CHECK (clientStatus IN (
    'captured','reviewing','needs_information','accepted','in_progress','released','resolved','closed'
  )),
  publicSummary TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  UNIQUE (id, organizationId),
  UNIQUE (slackSurfaceId, messageTs),
  FOREIGN KEY (slackSurfaceId, organizationId)
    REFERENCES ariahq_slack_surfaces(id, organizationId) ON DELETE RESTRICT,
  FOREIGN KEY (workItemId, organizationId)
    REFERENCES devflow_work_items(id, organizationId) ON DELETE RESTRICT
);
CREATE INDEX idx_ariahq_client_intakes_item
  ON ariahq_client_intakes(organizationId, workItemId, lastUpdatedAt DESC);
