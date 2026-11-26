-- Normalize legacy ISO timestamps to the fixed-width UTC text the scheduler compares.
-- Interpret bare dates and SQLite-style timestamps as UTC. Truncate fractional
-- seconds before casting so Postgres cannot round a value into the next millisecond.
WITH legacy AS (
  SELECT id,
    regexp_replace("nextRunAt", '([.][0-9]{3})[0-9]+', '\1') AS value
  FROM scheduled_tasks
  WHERE "nextRunAt" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$'
    AND "nextRunAt" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
), zoned AS (
  SELECT id, CASE
    WHEN length(value) = 10 THEN value || 'T00:00:00Z'
    WHEN value ~ '(Z|[+-][0-9]{2}:?[0-9]{2})$' THEN value
    ELSE value || 'Z'
  END AS value
  FROM legacy
), parsed AS (
  SELECT id, CASE WHEN pg_input_is_valid(value, 'timestamp with time zone')
    THEN value::timestamptz AT TIME ZONE 'UTC'
  END AS utc
  FROM zoned
)
UPDATE scheduled_tasks AS schedule
SET "nextRunAt" = to_char(parsed.utc, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM parsed
WHERE schedule.id = parsed.id
  AND parsed.utc >= timestamp '0001-01-01'
  AND parsed.utc < timestamp '10000-01-01';
