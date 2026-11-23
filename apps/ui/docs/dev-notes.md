# Dev notes (in-page review comments)

Moved from `apps/ui/CLAUDE.md`, which keeps the rule that causes damage when missed and a pointer here. Paths are relative to `apps/ui/` unless a line says repo root.

<!-- Applies when someone reviews the running dashboard with in-page notes, asks you to take or process their UI comments, or you start the dev server for a UI review. -->

`DEV_NOTES=1 bun run dev` adds a review overlay to the dev server only (`dev-notes/vite-plugin.ts`, `apply: "serve"`). Production builds never contain it. The reviewer clicks `+` on the right edge, clicks an element, and types a note. Notes show as numbered pins.

Each note records the path, viewport, theme, element text, a selector, and the React owner chain (for example `StatusBadge < StatusCell < … < TasksPage`). Search the code for those component names to find the source. Notes live in `apps/ui/.dev-notes/notes.json` (gitignored; `DEV_NOTES_FILE` overrides it).

From `apps/ui`:

| Command | What it does |
|---|---|
| `bun dev-notes/cli.ts list` | Open notes (`--all` includes done ones) |
| `bun dev-notes/cli.ts done <n> "<what you changed>"` | Mark note `#n` done with a reply that shows in the panel |
| `bun dev-notes/cli.ts reply <n> "<question>"` | Answer and keep the note open |

Open tabs update at once. Mark a note done only after the change is in and verified in the browser.
