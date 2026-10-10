-- Byte-exact replay state for workflow runs, sealed at rest.
--
-- `workflow_run_steps.output` and `workflow_runs.context` are scrubbed at write
-- for display and SQL filters (`json_extract(context, '$.swarm.requestedByUserId')`).
-- Resume, retry, dedup and recovery rebuild the live ctx from these values, so
-- they need the exact value: these columns hold it, encrypted with `sealJson`
-- (src/be/sealed-json.ts). NULL for rows written before this migration; their
-- readers fall back to the plain column.
ALTER TABLE workflow_run_steps ADD COLUMN output_replay TEXT;
ALTER TABLE workflow_runs ADD COLUMN context_replay TEXT;
