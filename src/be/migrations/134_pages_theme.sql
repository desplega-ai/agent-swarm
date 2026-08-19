-- Optional theme-preset id for DB-backed pages, mirroring the app-definition
-- `theme` field (`src/apps/definition.ts` AppThemeIdSchema). Nullable — a page
-- with no theme renders unscoped (inherits the viewer's own dashboard theme,
-- today's behavior). See spike:
-- thoughts/c06cca59-187e-4aa6-8472-8ac6caf177af/research/2026-08-19-pages-apps-unification.md
ALTER TABLE pages ADD COLUMN theme TEXT;
