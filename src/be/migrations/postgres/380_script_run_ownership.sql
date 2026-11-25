ALTER TABLE script_runs ADD COLUMN "ownerId" TEXT;
ALTER TABLE script_runs ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(3);
CREATE INDEX idx_script_runs_owner_lease ON script_runs ("ownerId", "leaseExpiresAt") WHERE status = 'running';
