-- Add encryption flag to swarm_config
-- Values with encrypted=1 are stored as base64(iv || ciphertext || authTag) AES-256-GCM.
-- Legacy plaintext rows default to encrypted=0 and will be auto-migrated on next boot
-- by initDb() before normal config reads occur.

ALTER TABLE swarm_config ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;

-- The column defaults to 0 so pre-existing rows altered by this migration stay
-- marked as plaintext until initDb() auto-encrypts legacy isSecret=1 rows.
-- From then on, the write path will set encrypted=1 explicitly for isSecret=1 rows.
