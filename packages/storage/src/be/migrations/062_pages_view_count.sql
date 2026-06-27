-- Adds a per-page view counter to the `pages` table. Bumped on every
-- successful 200 from `GET /p/:id` (HTML inline serve) and `GET /p/:id.json`
-- (JSON metadata fetch). 302/401/403/404 responses do NOT bump. No
-- per-viewer dedup — Taras explicitly wanted a "super simple counter field".
--
-- Bump path: src/http/pages-public.ts → bumpViewCount() → incrementPageViewCount()
-- in src/be/db.ts. Wrapped in try/catch so analytics never breaks page serving.

ALTER TABLE pages ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
