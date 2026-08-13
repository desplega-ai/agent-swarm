-- Historical inline script runs did not retain the generated scratch slug, so
-- refresh existing scratch rows once to give them a full retention window
-- under the new last-used tracking policy.
UPDATE scripts
SET updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE scope = 'agent' AND isScratch = 1 AND name GLOB 'scratch-*';
