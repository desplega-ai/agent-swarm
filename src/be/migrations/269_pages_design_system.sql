-- Pages design system v2: three columns that say how an HTML page is styled.
--
-- design_version  Which design system serves the page. 1 is the original
--                 look (Tailwind v3 Play CDN, `--swarm-*` hex tokens) and stays
--                 frozen. 2 is the swarm design system (theme tokens, `swarm-*`
--                 primitives, Tailwind v4). The DEFAULT makes every existing row
--                 read 1, so old pages keep their look. New pages get 2 from
--                 createPage(), which inserts the value explicitly.
-- theme           Preset id from the dashboard theme registry (for example
--                 `paper`). NULL pins nothing: the page follows the viewer's
--                 theme, then falls back to `hive`. Design version 2 only.
-- theme_tokens    JSON `{"light": {...}, "dark": {...}}` of per-page overrides,
--                 keyed by page token names (`--color-primary`, `--radius-lg`).
--                 Stored normalized by importThemeTokens() (src/themes/import.ts).
--                 NULL means no overrides. Design version 2 only.
--
-- Both theme columns are NULL for every existing row. Neither one has a CHECK:
-- the preset ids live in code (src/themes/presets.ts), so the write paths
-- validate them, and a stale id read from the table is ignored at render time.

ALTER TABLE pages ADD COLUMN theme TEXT;
ALTER TABLE pages ADD COLUMN theme_tokens TEXT;
ALTER TABLE pages ADD COLUMN design_version INTEGER NOT NULL DEFAULT 1;
