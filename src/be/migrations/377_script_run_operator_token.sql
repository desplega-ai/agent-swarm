ALTER TABLE session_tokens ADD COLUMN "operatorRun" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE script_runs ADD COLUMN "executionPrincipal" TEXT;
