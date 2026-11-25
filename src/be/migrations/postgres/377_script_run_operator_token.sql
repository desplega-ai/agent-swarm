ALTER TABLE session_tokens ADD COLUMN "operatorRun" boolean NOT NULL DEFAULT false;
ALTER TABLE script_runs ADD COLUMN "executionPrincipal" TEXT;
