-- Page kit: the `{ template, slots }` spec a kit page was written from.
-- Same column as the SQLite file of this ordinal: JSON text validated by
-- PageKitSchema (src/pages/kit/schema.ts) on write, NULL for every free-HTML,
-- JSON and SVG page. No CHECK: the spec shape lives in code.

ALTER TABLE "pages" ADD COLUMN "kit" text;
