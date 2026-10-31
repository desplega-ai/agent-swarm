-- Reporting groups ChatGPT subscription usage with Codex's bare OpenAI id.
-- Runtime routing stays in agent_tasks.model, latestModel, and session logs.
-- Match chatgptSubscriptionModelId(): one nonempty id, no additional slash.
UPDATE session_costs
SET model = lower(substr(trim(model), 14))
WHERE lower(trim(model)) LIKE 'openai-codex/%'
  AND length(trim(model)) > 13
  AND instr(substr(trim(model), 14), '/') = 0;

UPDATE session_costs
SET modelBreakdown = (
  SELECT json_group_array(json(
    CASE
      WHEN lower(trim(json_extract(value, '$.model'))) LIKE 'openai-codex/%'
        AND length(trim(json_extract(value, '$.model'))) > 13
        AND instr(substr(trim(json_extract(value, '$.model')), 14), '/') = 0
      THEN json_set(value, '$.model', lower(substr(trim(json_extract(value, '$.model')), 14)))
      ELSE value
    END
  ))
  FROM json_each(session_costs.modelBreakdown)
)
WHERE modelBreakdown IS NOT NULL
  AND json_valid(modelBreakdown)
  AND EXISTS (
    SELECT 1 FROM json_each(session_costs.modelBreakdown)
    WHERE lower(trim(json_extract(value, '$.model'))) LIKE 'openai-codex/%'
      AND length(trim(json_extract(value, '$.model'))) > 13
      AND instr(substr(trim(json_extract(value, '$.model')), 14), '/') = 0
  );
