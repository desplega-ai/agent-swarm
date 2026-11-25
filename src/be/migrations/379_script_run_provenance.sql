ALTER TABLE user_tokens ADD COLUMN "runProvenance" TEXT;
ALTER TABLE user_identity_events ADD COLUMN "runProvenance" TEXT;
ALTER TABLE session_tokens ADD COLUMN "brokerParentId" TEXT;
