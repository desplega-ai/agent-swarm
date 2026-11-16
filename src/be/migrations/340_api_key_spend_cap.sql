-- Spend cap behind a key's current rate limit: a JSON object
-- `{limitUsd, spendUsd, resetsAt}` when the provider refused the key because it
-- hit its spend limit (OpenRouter 403 key limit, 402 insufficient credits).
-- NULL for an ordinary rate limit. Read only while `status = 'rate_limited'`.
ALTER TABLE api_key_status ADD COLUMN spendCap TEXT;
