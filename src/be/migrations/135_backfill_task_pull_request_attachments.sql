-- Migration 135: backfill canonical GitHub pull-request attachments from historical task output.
--
-- Runtime task completion and VCS detection now write these rows directly. This
-- migration repairs the legacy history without deleting or rewriting any
-- caller-authored attachment. Re-running is safe: the NOT EXISTS guard treats
-- task + canonical URL as the identity regardless of display name.

WITH RECURSIVE
candidate_tasks(task_id, agent_id, output) AS (
  SELECT id, agentId, output
  FROM agent_tasks
  WHERE output IS NOT NULL
    AND instr(lower(output), 'github.com/') > 0
),
normalized(task_id, agent_id, value) AS (
  SELECT
    task_id,
    agent_id,
    trim(
      replace(replace(replace(replace(
      replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        output, char(9), ' '), char(10), ' '), char(13), ' '),
        '(', ' '), ')', ' '), '[', ' '), ']', ' '), '{', ' '), '}', ' '), '<', ' '),
        '>', ' '), char(34), ' '), char(39), ' '), char(96), ' ')
    )
  FROM candidate_tasks
),
tokens(task_id, agent_id, remaining, token) AS (
  SELECT
    task_id,
    agent_id,
    value || ' ',
    NULL
  FROM normalized

  UNION ALL

  SELECT
    task_id,
    agent_id,
    ltrim(substr(remaining, instr(remaining, ' ') + 1)),
    substr(remaining, 1, instr(remaining, ' ') - 1)
  FROM tokens
  WHERE remaining <> ''
),
token_paths(task_id, agent_id, token, path) AS (
  SELECT
    task_id,
    agent_id,
    token,
    CASE
      WHEN lower(token) GLOB 'https://github.com/*'
        THEN substr(token, length('https://github.com/') + 1)
      WHEN lower(token) GLOB 'http://github.com/*'
        THEN substr(token, length('http://github.com/') + 1)
      ELSE substr(token, length('github.com/') + 1)
    END
  FROM tokens
  WHERE lower(token) GLOB 'https://github.com/*'
     OR lower(token) GLOB 'http://github.com/*'
     OR lower(token) GLOB 'github.com/*'
),
token_segments(task_id, agent_id, token, owner, repo, remainder) AS (
  SELECT
    task_id,
    agent_id,
    token,
    substr(path, 1, instr(path, '/') - 1),
    substr(
      substr(path, instr(path, '/') + 1),
      1,
      instr(substr(path, instr(path, '/') + 1), '/') - 1
    ),
    substr(
      substr(path, instr(path, '/') + 1),
      instr(substr(path, instr(path, '/') + 1), '/') + 1
    )
  FROM token_paths
  WHERE instr(path, '/') > 1
    AND instr(substr(path, instr(path, '/') + 1), '/') > 1
),
digit_scan(task_id, agent_id, token, position) AS (
  SELECT
    task_id,
    agent_id,
    'https://github.com/' || owner || '/' || repo || '/' || remainder,
    instr(
      lower('https://github.com/' || owner || '/' || repo || '/' || remainder),
      '/pull/'
    ) + length('/pull/')
  FROM token_segments
  WHERE owner NOT GLOB '*[^A-Za-z0-9._-]*'
    AND repo NOT GLOB '*[^A-Za-z0-9._-]*'
    AND lower(remainder) GLOB 'pull/[0-9]*'

  UNION ALL

  SELECT task_id, agent_id, token, position + 1
  FROM digit_scan
  WHERE substr(token, position, 1) GLOB '[0-9]'
),
canonical_pull_requests(task_id, agent_id, url) AS (
  SELECT
    task_id,
    agent_id,
    substr(token, 1, max(position) - 1)
  FROM digit_scan
  GROUP BY task_id, agent_id, token
  HAVING substr(token, max(position), 1) = ''
    OR unicode(substr(token, max(position), 1)) IN (
      9, 10, 13, 32, 33, 34, 35, 39, 41, 44, 46, 47, 58, 59, 62, 63, 93, 96, 125
    )
)
INSERT INTO task_attachments (
  id,
  task_id,
  agent_id,
  name,
  kind,
  url,
  provider_id,
  provider_key,
  intent,
  description,
  is_primary
)
SELECT
  lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  candidate.task_id,
  candidate.agent_id,
  'GitHub pull request #' || substr(candidate.url, instr(lower(candidate.url), '/pull/') + 6),
  'url',
  candidate.url,
  'github',
  candidate.url,
  'task-deliverable',
  'Pull request shipped by this task',
  0
FROM canonical_pull_requests candidate
WHERE NOT EXISTS (
    SELECT 1
    FROM task_attachments existing
    WHERE existing.task_id = candidate.task_id
      AND existing.kind = 'url'
      AND EXISTS (
        SELECT 1
        FROM (
          SELECT substr(lower(candidate.url), 9) AS base_url
          UNION ALL
          SELECT lower(candidate.url)
          UNION ALL
          SELECT 'http://' || substr(lower(candidate.url), 9)
        ) forms
        WHERE lower(trim(existing.url)) = forms.base_url
          OR (
            substr(lower(trim(existing.url)), 1, length(forms.base_url)) = forms.base_url
            AND unicode(substr(lower(trim(existing.url)), length(forms.base_url) + 1, 1)) IN (
              9, 10, 13, 32, 33, 34, 35, 39, 41, 44, 46, 47, 58, 59, 62, 63, 93, 96, 125
            )
          )
      )
  )
GROUP BY candidate.task_id, lower(candidate.url);
