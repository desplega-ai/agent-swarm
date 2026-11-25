ALTER TABLE script_runs ADD COLUMN "ownerId" TEXT;
ALTER TABLE script_runs ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ;
CREATE INDEX idx_script_runs_owner_lease ON script_runs ("ownerId", "leaseExpiresAt") WHERE status = 'running';
