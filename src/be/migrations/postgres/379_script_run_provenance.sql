ALTER TABLE user_tokens ADD COLUMN "runProvenance" jsonb;
ALTER TABLE user_identity_events ADD COLUMN "runProvenance" jsonb;
ALTER TABLE session_tokens ADD COLUMN "brokerParentId" TEXT;
