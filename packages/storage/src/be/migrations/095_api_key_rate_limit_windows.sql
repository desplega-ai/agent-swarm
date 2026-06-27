-- Persist provider-emitted rate-limit window telemetry on credential rows.
-- Shape is JSON keyed by provider window type, e.g.
-- {"five_hour":{"status":"allowed_warning","utilization":0.82,"resetsAt":1781334000,"isUsingOverage":false,"surpassedThreshold":0.75,"lastSeenAt":"..."}}

ALTER TABLE api_key_status ADD COLUMN rateLimitWindows TEXT NOT NULL DEFAULT '{}';
