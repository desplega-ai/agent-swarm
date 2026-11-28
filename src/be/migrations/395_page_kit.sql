-- Page kit: the `{ template, slots }` spec a kit page was written from.
--
-- kit  JSON spec, validated by PageKitSchema (src/pages/kit/schema.ts) on
--      write. NULL for every free-HTML, JSON and SVG page. When set, `/p/:id`
--      renders the page from it on each read, so a renderer fix restyles every
--      kit page; `body` keeps the last rendered HTML for listings, search and
--      version history. Any write that sets `body` without a kit clears it.
--
-- No CHECK: the spec shape lives in code, and a stored spec that no longer
-- validates falls back to the stored `body` at render time.

ALTER TABLE pages ADD COLUMN kit TEXT;
