-- Backfill Kapso/WhatsApp sender identities into the canonical user registry.
--
-- Native Kapso inbound messages resolve their sender through user_external_ids
-- using kind='kapso' and the normalized WhatsApp phone number from
-- message.from/conversation.phone_number. Existing user profiles can already
-- carry WhatsApp numbers in notes in the documented form:
--
--   WhatsApp: +34 ... (E.164: 346...)
--
-- Link those existing, human-curated profile rows instead of leaving inbound
-- Kapso sender rows unmapped. This is idempotent and preserves any existing
-- mapping for a phone number.

INSERT OR IGNORE INTO user_external_ids (kind, externalId, userId)
WITH raw_notes AS (
  SELECT
    id AS userId,
    substr(notes, instr(notes, 'E.164:') + length('E.164:')) AS e164_suffix
  FROM users
  WHERE notes LIKE '%WhatsApp:%'
    AND notes LIKE '%E.164:%'
),
parsed AS (
  SELECT
    userId,
    trim(
      CASE
        WHEN instr(e164_suffix, ')') > 0 THEN substr(e164_suffix, 1, instr(e164_suffix, ')') - 1)
        ELSE e164_suffix
      END
    ) AS e164_value
  FROM raw_notes
),
normalized AS (
  SELECT
    userId,
    replace(replace(replace(replace(e164_value, '+', ''), ' ', ''), '-', ''), '.', '') AS externalId
  FROM parsed
)
SELECT 'kapso', externalId, userId
FROM normalized
WHERE externalId <> ''
  AND externalId NOT GLOB '*[^0-9]*';
