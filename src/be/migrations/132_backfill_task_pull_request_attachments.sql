-- Backfill canonical GitHub pull-request attachments from historical task output.
--
-- Runtime task completion and VCS detection now write these rows directly. This
-- migration repairs the legacy history without deleting or rewriting any
-- caller-authored attachment. Re-running is safe: the NOT EXISTS guard treats
-- task + canonical URL as the identity regardless of display name.

WITH RECURSIVE
candidate_tasks(task_id, agent_id, remaining) AS (
  SELECT id, agentId, output
  FROM agent_tasks
  WHERE output IS NOT NULL
    AND instr(lower(output), 'github.com/') > 0
),
occurrences(task_id, agent_id, url_tail, remaining, valid_boundary) AS (
  SELECT task_id, agent_id, NULL, remaining, 0
  FROM candidate_tasks

  UNION ALL

  SELECT
    task_id,
    agent_id,
    substr(remaining, instr(lower(remaining), 'github.com/')),
    substr(
      remaining,
      instr(lower(remaining), 'github.com/') + length('github.com/')
    ),
    instr(lower(remaining), 'github.com/') = 1
      OR substr(remaining, instr(lower(remaining), 'github.com/') - 1, 1)
        NOT GLOB '[A-Za-z0-9.-]'
  FROM occurrences
  WHERE instr(lower(remaining), 'github.com/') > 0
),
tokens(task_id, agent_id, token) AS (
  SELECT
    task_id,
    agent_id,
    substr(cleaned, 1, instr(cleaned || ' ', ' ') - 1)
  FROM (
    SELECT
      task_id,
      agent_id,
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(url_tail, char(9), ' '),
                      char(10), ' '
                    ),
                    char(13), ' '
                  ),
                  ')', ' '
                ),
                ']', ' '
              ),
              '>', ' '
            ),
            '"', ' '
          ),
          '''', ' '
        ),
        '`', ' '
      ) AS cleaned
    FROM occurrences
    WHERE url_tail IS NOT NULL
      AND valid_boundary
  )
),
token_paths(task_id, agent_id, token, path) AS (
  SELECT
    task_id,
    agent_id,
    token,
    substr(token, length('github.com/') + 1)
  FROM tokens
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
    'https://github.com/' || substr(token, length('github.com/') + 1),
    instr(
      lower('https://github.com/' || substr(token, length('github.com/') + 1)),
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
  'url',
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
      AND (
        lower(trim(existing.url)) = substr(lower(candidate.url), 9)
        OR lower(trim(existing.url)) = lower(candidate.url)
        OR lower(trim(existing.url)) = 'http://' || substr(lower(candidate.url), 9)
        OR lower(trim(existing.url)) GLOB substr(lower(candidate.url), 9) || '[^0-9]*'
        OR lower(trim(existing.url)) GLOB lower(candidate.url) || '[^0-9]*'
        OR lower(trim(existing.url)) GLOB
          'http://' || substr(lower(candidate.url), 9) || '[^0-9]*'
      )
  )
GROUP BY candidate.task_id, lower(candidate.url);
