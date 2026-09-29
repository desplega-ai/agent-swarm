-- Profile-sync banner (fetchProfileSyncRejectionBanner, src/commands/profile-sync.ts).
--
-- Every worker session start or resume looks up the latest
-- system.profile_sync_rejected / system.profile_sync_reconciled event per
-- identity field for its own agent: `event IN (...) AND agentId = ?`, newest
-- first. With only single-column indexes SQLite picked one of idx_events_event
-- or idx_events_agentId and scanned every candidate row, synchronously on the
-- API's event loop. This index seeks straight to the agent's rows for each
-- event name, already in createdAt order.
CREATE INDEX IF NOT EXISTS idx_events_event_agent_created
  ON events(event, agentId, createdAt DESC);
