-- Fix date storage format inconsistency: convert bare datetime format
-- (YYYY-MM-DD HH:MM:SS) to ISO 8601 UTC (YYYY-MM-DDTHH:MM:SS.000Z).
--
-- Affected tables use datetime('now') or CURRENT_TIMESTAMP defaults which
-- produce bare format. Browsers parse these as local time instead of UTC.

-- Update existing bare-format dates to ISO 8601 in all affected tables.
-- The pattern: replace space with T and append .000Z for dates matching bare format.

-- workflows
UPDATE workflows SET
  createdAt = replace(createdAt, ' ', 'T') || '.000Z'
  WHERE createdAt LIKE '____-__-__ __:__:__' AND createdAt NOT LIKE '%T%';
UPDATE workflows SET
  lastUpdatedAt = replace(lastUpdatedAt, ' ', 'T') || '.000Z'
  WHERE lastUpdatedAt LIKE '____-__-__ __:__:__' AND lastUpdatedAt NOT LIKE '%T%';

-- workflow_runs
UPDATE workflow_runs SET
  startedAt = replace(startedAt, ' ', 'T') || '.000Z'
  WHERE startedAt LIKE '____-__-__ __:__:__' AND startedAt NOT LIKE '%T%';
UPDATE workflow_runs SET
  lastUpdatedAt = replace(lastUpdatedAt, ' ', 'T') || '.000Z'
  WHERE lastUpdatedAt LIKE '____-__-__ __:__:__' AND lastUpdatedAt NOT LIKE '%T%';
UPDATE workflow_runs SET
  finishedAt = replace(finishedAt, ' ', 'T') || '.000Z'
  WHERE finishedAt IS NOT NULL AND finishedAt LIKE '____-__-__ __:__:__' AND finishedAt NOT LIKE '%T%';

-- workflow_run_steps
UPDATE workflow_run_steps SET
  startedAt = replace(startedAt, ' ', 'T') || '.000Z'
  WHERE startedAt LIKE '____-__-__ __:__:__' AND startedAt NOT LIKE '%T%';
UPDATE workflow_run_steps SET
  finishedAt = replace(finishedAt, ' ', 'T') || '.000Z'
  WHERE finishedAt IS NOT NULL AND finishedAt LIKE '____-__-__ __:__:__' AND finishedAt NOT LIKE '%T%';
UPDATE workflow_run_steps SET
  nextRetryAt = replace(nextRetryAt, ' ', 'T') || '.000Z'
  WHERE nextRetryAt IS NOT NULL AND nextRetryAt LIKE '____-__-__ __:__:__' AND nextRetryAt NOT LIKE '%T%';

-- tracker_sync
UPDATE tracker_sync SET
  lastSyncedAt = replace(lastSyncedAt, ' ', 'T') || '.000Z'
  WHERE lastSyncedAt LIKE '____-__-__ __:__:__' AND lastSyncedAt NOT LIKE '%T%';
UPDATE tracker_sync SET
  createdAt = replace(createdAt, ' ', 'T') || '.000Z'
  WHERE createdAt LIKE '____-__-__ __:__:__' AND createdAt NOT LIKE '%T%';

-- tracker_agent_mapping
UPDATE tracker_agent_mapping SET
  createdAt = replace(createdAt, ' ', 'T') || '.000Z'
  WHERE createdAt LIKE '____-__-__ __:__:__' AND createdAt NOT LIKE '%T%';

-- approval_requests
UPDATE approval_requests SET
  createdAt = replace(createdAt, ' ', 'T') || '.000Z'
  WHERE createdAt LIKE '____-__-__ __:__:__' AND createdAt NOT LIKE '%T%';
UPDATE approval_requests SET
  updatedAt = replace(updatedAt, ' ', 'T') || '.000Z'
  WHERE updatedAt LIKE '____-__-__ __:__:__' AND updatedAt NOT LIKE '%T%';
UPDATE approval_requests SET
  resolvedAt = replace(resolvedAt, ' ', 'T') || '.000Z'
  WHERE resolvedAt IS NOT NULL AND resolvedAt LIKE '____-__-__ __:__:__' AND resolvedAt NOT LIKE '%T%';
UPDATE approval_requests SET
  expiresAt = replace(expiresAt, ' ', 'T') || '.000Z'
  WHERE expiresAt IS NOT NULL AND expiresAt LIKE '____-__-__ __:__:__' AND expiresAt NOT LIKE '%T%';

-- channel_activity_cursors
UPDATE channel_activity_cursors SET
  updatedAt = replace(updatedAt, ' ', 'T') || '.000Z'
  WHERE updatedAt LIKE '____-__-__ __:__:__' AND updatedAt NOT LIKE '%T%';

-- oauth_apps
UPDATE oauth_apps SET
  updatedAt = replace(updatedAt, ' ', 'T') || '.000Z'
  WHERE updatedAt LIKE '____-__-__ __:__:__' AND updatedAt NOT LIKE '%T%';

-- oauth_tokens
UPDATE oauth_tokens SET
  updatedAt = replace(updatedAt, ' ', 'T') || '.000Z'
  WHERE updatedAt LIKE '____-__-__ __:__:__' AND updatedAt NOT LIKE '%T%';

-- workflow_versions
UPDATE workflow_versions SET
  createdAt = replace(createdAt, ' ', 'T') || '.000Z'
  WHERE createdAt LIKE '____-__-__ __:__:__' AND createdAt NOT LIKE '%T%';
