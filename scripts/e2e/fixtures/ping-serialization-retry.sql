-- The scenario renames its worker through the API to select the failing write.
-- Each trigger supplies the column that identifies the worker in its row.
CREATE FUNCTION fail_ping() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agents
    WHERE id = (to_jsonb(NEW) ->> TG_ARGV[0]) AND name = 'ping-conflict-' || TG_TABLE_NAME
  ) THEN
    RAISE serialization_failure USING MESSAGE = 'injected ping conflict';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fail_ping_update BEFORE UPDATE OF status ON agents
FOR EACH ROW EXECUTE FUNCTION fail_ping('id');

CREATE TRIGGER fail_ping_log BEFORE INSERT ON agent_log
FOR EACH ROW WHEN (NEW."eventType" = 'agent_status_change') EXECUTE FUNCTION fail_ping('agentId');
