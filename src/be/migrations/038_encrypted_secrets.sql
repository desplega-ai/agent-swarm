-- Add encryption flag to swarm_config
-- Values with encrypted=1 are stored as base64(iv || ciphertext || authTag) AES-256-GCM.
-- Legacy plaintext rows default to encrypted=0 and will be auto-migrated on next boot
-- (see initDb() auto-encrypt hook, landing in a follow-up phase).

ALTER TABLE swarm_config ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;

-- New rows default to 0 because existing rows added by this migration are plaintext.
-- A follow-up auto-encrypt hook in initDb() will promote isSecret=1 rows to encrypted=1.
-- From then on, the write path will set encrypted=1 explicitly for isSecret=1 rows.
