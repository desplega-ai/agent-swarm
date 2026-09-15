-- Historical routing reasons have unknown provenance; do not backfill them.
ALTER TABLE agent_tasks ADD COLUMN routing_source TEXT
  CHECK (routing_source IN ('declared', 'engine_default'));
