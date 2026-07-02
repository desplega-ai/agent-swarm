-- Fix: template seeding created a spurious version 2 ("Reset to default") for every
-- seeded template because upsertPromptTemplate hardcoded isDefault=0, requiring
-- an immediate resetPromptTemplateToDefault call to flip it.

-- Delete spurious "Reset to default" history entries created by the two-step seed.
-- These are version=2 entries where version=1 for the same template has identical body.
DELETE FROM prompt_template_history
WHERE version = 2
  AND changeReason = 'Reset to default'
  AND templateId IN (
    SELECT h2.templateId
    FROM prompt_template_history h2
    JOIN prompt_template_history h1
      ON h1.templateId = h2.templateId
      AND h1.version = 1
      AND h1.changeReason = 'Seeded from code registry'
      AND h1.body = h2.body
    WHERE h2.version = 2
      AND h2.changeReason = 'Reset to default'
  );

-- Reset version back to 1 for templates that are currently at version=2
-- and only have version=1 history remaining (the spurious v2 was just deleted).
UPDATE prompt_templates
SET version = 1
WHERE version = 2
  AND isDefault = 1
  AND id NOT IN (
    SELECT templateId FROM prompt_template_history WHERE version = 2
  );
