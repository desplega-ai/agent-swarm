-- Backfill the native Kapso/WhatsApp phone-number routing mapping.
--
-- PR #560 introduced native routing through kv_entries:
--   namespace = 'integrations:kapso:numbers'
--   key       = KAPSO_PHONE_NUMBER_ID
--
-- Existing swarms can already have KAPSO_PHONE_NUMBER_ID configured without the
-- corresponding KV mapping, because the mapping is normally created by the
-- register-kapso-number tool. Create that missing row from the non-secret
-- global config and route inbound messages to the current lead agent, matching
-- the tool's default behavior. Preserve any existing mapping.

INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at)
SELECT
  'integrations:kapso:numbers',
  phone.value,
  '{"phoneNumberId":"' || replace(phone.value, '"', '\"') ||
    '","agentId":"' || lead.id ||
    '","name":"Configured Kapso number","createdAt":"' || strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ||
    '"}',
  'json',
  NULL,
  CAST(unixepoch('subsec') * 1000 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM swarm_config AS phone
JOIN agents AS lead ON lead.isLead = 1
WHERE phone.scope = 'global'
  AND phone.scopeId IS NULL
  AND phone.key = 'KAPSO_PHONE_NUMBER_ID'
  AND phone.encrypted = 0
  AND length(phone.value) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM kv_entries AS existing
    WHERE existing.namespace = 'integrations:kapso:numbers'
      AND existing.key = phone.value
  )
ORDER BY lead.createdAt ASC
LIMIT 1;
