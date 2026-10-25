---
date: 2026-10-25T18:10:00Z
topic: "Comb: browse and search like agent-fs (round 3 feedback)"
status: in-progress
autopilot: true
---

# Comb: browse and search like agent-fs (round 3 feedback)

## Goal

Taras sent 12 items of feedback on Comb after PR #2420 merged (2026-10-25, 18:40 BCN). This PR
brings Comb's browsing, search and file handling close to the agent-fs live UI: mono file icons,
a better frontmatter block, the outline in the right panel, agent-fs favorites, a row menu with
write actions, tree and folder filters, a search with URL state and thumbnails, and assets that
open in a modal and take comments. One new PR on `feat/comb-browse`, not merged.

## Taras's feedback (verbatim, numbered)

1. Search should be: file, semantic then text + shortcuts to move between them
2. Md assets like mermaid diagrams, pictures, etc should be properly rendered and should have a
   way to: maximize -> modal & comment them
3. There should be a way to search for files inside a folder, like filtering the names
4. On hover in the sidebar should offer a sort of popover for the file, check agent-fs
5. On search (semantic / text) it should show thumbnails of the assets that support it
6. Add a copy path icon
7. Make frontmatter better formatted and collapsible
8. Why agent-fs favourites not appearing in comb? are they using the same be?
9. Should we use b&w icons / thumbnails on documents to make them more eye appealing?
10. Move the outline to a tab of the right panel (as in agent-fs), so that moving in files does
    not remove the file tree by default
11. A way to search in the left sidebar, which filters the tree by the matches
12. Query params for search and similar state, so it is sharable and Back works

## Facts (agent-fs 0.18.5 source, Comb on main fa1543744)

- **Favorites (item 8):** different backends. Comb stores stars in the dashboard `favorites` table
  (kind `agent-fs-path`, per dashboard user). The live UI uses agent-fs ops `favorite-list`,
  `favorite-add {path}`, `favorite-remove {path}` (per agent-fs user and drive, feature
  `favorites` in `/health`). `mv` carries a star, `rm` drops it. The dashboard sidebar pins
  (`comb-sidebar-pins.tsx`) read the same dashboard table.
- **Row menu (item 4):** the live tree row has a hover `...` DropdownMenu and a right-click
  ContextMenu with one shared item list. Truncated names get a full-name tooltip. Write actions:
  New file (`write`, create-only, markdown starts with `# <name>`), New folder (`<folder>/.keep`),
  Rename (`mv {from,to}`, files only), Delete (`rm {path}`, files only). `mv` does not move
  comments. `rm` soft-deletes the file's comments.
- **Icons (item 9):** the live UI colors icons per type. `apps/ui/DESIGN.md` allows one accent
  (Hive Amber) and the `check:tokens` gate rejects palette literals.
- **Outline (item 10):** the live right panel has two tabs, Comments and Outline, and only shows
  tabs when the document has headings.
- **Tree search (item 11):** the live sidebar calls `find {query, limit: 50}` (drive-wide fuzzy
  names, 2 characters minimum). `find` also takes `path` to scope the search to a folder.
- **Search (items 1, 5, 12):** the live modal has no mode shortcuts and no URL state. Image hits
  show a 40 px thumbnail of the full image (no thumbnail op exists).
- **Assets (item 2):** the live UI has a lightbox for images and mermaid (expand, download).
  Comment anchors are text only (quote and line range). The live UI cannot comment on an asset.
- **Frontmatter (item 7):** Comb parses with `yaml` and shows the raw block on an error. The live
  UI uses a line parser, so `topic: Seed deck ($5M raise): companies` reads as one string.

## Decisions

- Favorites: agent-fs favorites when the server has the `favorites` feature. Existing dashboard
  stars on the swarm drive are imported (copied) once per browser and agent-fs user, marked in
  localStorage. The dashboard keeps its stars. Without the feature, Comb keeps the dashboard
  table. The sidebar pins follow the same source. (asked)
- Asset comments: the live UI has none, so Comb anchors an asset comment to the asset's source
  lines and outlines the whole block. (asked: "the same way agent-fs does, or 1")
- Icons: one mono lucide icon per file kind. Image thumbnails only in search results. (asked)
- Row menu: read and write actions, like the live UI: Open, Open in new tab, Copy link, Copy path,
  Share, favorite, Download, New file, New folder, Rename, Delete, Open in agent-fs. Rename and
  Delete only for files, as in the live UI. (asked)
- Mode switching: Tab and Shift+Tab in the search box cycle File, Semantic, Text. The modes show
  as a hint next to the control. (assumed)
- URL state: the search dialog is `?q=<query>&mode=<file|semantic|text>`. Opening pushes one
  history entry, typing replaces it, closing goes back. The folder filter is `?filter=`. The tree
  filter stays in the panel (it lives across pages). (assumed)
- Frontmatter starts open, and the collapse choice is stored in this browser. (assumed)
- The drive root still collapses the left panel (Taras's round 2 choice). Files no longer collapse
  it or switch its tab. (assumed from item 10)

## Phase 1: Mono file kind icons

- `lib/comb/file-icons.ts`: map a name (and folder flag) to a lucide icon per kind: folder,
  markdown, image, audio, video, PDF, HTML, code, data (JSON, YAML, TOML, CSV), text, other.
- Use it in the tree, the folder grid and phone list, search results, Recent and Favorites lists,
  the home cards, and the sidebar pins. Color stays `text-muted-foreground`.

Verification: `bun test apps/ui/src/lib/comb/file-icons.test.ts`, `cd apps/ui && bunx tsc -b && bun run lint && bun run check:tokens`.

## Phase 2: Frontmatter

- Parse with `yaml`. On an error, fall back to a line parser (`key: rest of line`, `- item` lists,
  `[a, b]`), so a value with `: ` stays one string. Show the raw block only when neither works.
- Render as a collapsible "Properties" block: the key count in the header, lists as chips, URLs
  as links, dates and numbers in mono. Stored open state per browser.

Verification: `bun test apps/ui/src/lib/comb/frontmatter.test.ts apps/ui/src/components/comb/viewers/comb-markdown.test.tsx`.

## Phase 3: Outline in the right panel

- The right panel gets tabs Comments and Outline (Outline only on a file with headings). The tab
  is stored. A `?comment=` link switches to Comments.
- The left panel keeps Files, Recent and Favorites. Opening a file never changes its tab or
  collapses it. The drive root still collapses it for that page only. A stored `outline` tab
  reads as Files.

Verification: `bun test apps/ui/src/lib/comb/panels.test.ts`, tsc, lint.

## Phase 4: agent-fs favorites

- Client and hooks: `favorite-list`, `favorite-add`, `favorite-remove` (feature `favorites`).
- Pin button, Favorites tab and home card, sidebar pins read and write agent-fs when the feature
  exists. One import of the dashboard stars on the swarm drive, marked done in localStorage per
  agent-fs user.

Verification: `bun test apps/ui/src/lib/comb/favorites.test.ts`, tsc, lint.

## Phase 5: Row menu (read actions), full name tooltip, copy path

- `FileMenuItems` shared by a hover `...` DropdownMenu and a right-click ContextMenu on tree rows
  and folder rows: Open, Open in new tab, Copy link, Copy path, Share, favorite, Download, Open in
  agent-fs.
- Truncated names show the full name in a tooltip.
- A Copy path icon in the file and folder header.

Verification: tsc, lint, live QA (the menu is UI wiring over existing helpers, no new pure logic).

## Phase 6: Write actions

- New file and New folder (on folders), Rename and Delete (on files), with dialogs like the live
  UI. Create-only writes check `stat` first. Rename and Delete warn that comments stay on the old
  name or are removed. A 403 shows "You can only read this drive".
- The folder header gets a New menu next to Upload.

Verification: `bun test apps/ui/src/lib/comb/file-names.test.ts`, tsc, lint.

## Phase 7: Tree filter

- A filter box on top of the Files tab. Two or more characters call `find` (drive-wide, 50
  matches) and the tree shows only the matches and their folders, opened. Matched characters are
  marked. Escape clears. An agent-fs without `find` filters the loaded folders.

Verification: `bun test apps/ui/src/lib/comb/tree.test.ts`, tsc, lint.

## Phase 8: Folder filter

- A filter box in the folder header (`?filter=`). It filters the listed items at once. Two or
  more characters also list matches in subfolders (`find` scoped to the folder), with their
  relative path.

Verification: `bun test apps/ui/src/lib/comb/folder-filter.test.ts`, tsc, lint.

## Phase 9: Search

- Modes in the order File, Semantic, Text. Tab and Shift+Tab cycle them.
- Image hits show a small thumbnail (`useAgentFsMediaUrl`, lazy). Other hits show the mono icon.
- `?q=` and `?mode=` hold the dialog state: a shared link opens the same search, Back closes it,
  and Back from an opened result shows the search again.

Verification: `bun test apps/ui/src/lib/comb/search.test.ts`, tsc, lint.

## Phase 10: Assets

- Images and mermaid diagrams get a hover toolbar: Maximize and Comment. Maximize opens a modal
  (fit, zoom, download for images, SVG download for diagrams).
- Comment anchors to the asset's source lines (no quote). The block gets an outline while its
  comment is active, and its marker sits next to it.
- Check rendering on a wide diagram, a tall image, an SVG, and a broken image.

Verification: `bun test apps/ui/src/lib/comb/dom-text-space.test.ts apps/ui/src/components/comb/viewers/comb-markdown.test.tsx`, tsc, lint.

## Docs

- `docs-site/content/docs/(documentation)/ui/comb.mdx`: icons, frontmatter, panels, favorites,
  row menu, filters, search, assets.

## Manual E2E (whole feature, local stack)

```bash
# agent-fs from source, local storage, local nomic embeddings
AGENT_FS_HOME=/tmp/comb-browse/afs AGENT_FS_STORAGE_PROVIDER=local AGENT_FS_LOCAL_ROOT=/tmp/comb-browse/afs/storage \
  SERVER_PORT=$AFS_PORT SERVER_HOST=127.0.0.1 EMBEDDING_PROVIDER=local EMBEDDING_MODEL=nomic-embed-text-v1.5 \
  bun run ~/Documents/code/agent-fs/packages/cli/src/index.ts server
# API with a throwaway DB
DATABASE_PATH=/tmp/comb-browse/swarm.sqlite PORT=$API_PORT DESPLEGA_TELEMETRY_ENV=test \
  AGENT_FS_API_URL=http://127.0.0.1:$AFS_PORT COMB_ENABLED=true bun run start:http
# UI
cd apps/ui && VITE_PROXY_TARGET=http://127.0.0.1:$API_PORT bunx vite --port $UI_PORT
```

Seed: markdown with frontmatter (valid and the invalid `topic:` case), headings, a mermaid fence,
a relative PNG and SVG; a folder with 30 items; images for search thumbnails. Walk every phase at
1440x900 and 390x844 with agent-browser. Screenshots to
`qa/agent-swarm/2026-10-25-comb-browse/`. Record one video: tree filter, row menu rename, search
with Tab and Back, maximize and comment on a diagram.

## Verification (whole PR)

- `bun run check:local`, `bun run lint`, `bun run lint:slop`, `bun run tsc:check:tsc`
- `bun run test:root -- --parallel=4`, `bun run e2e`, `bun run e2e:ui`
- `bash scripts/check-db-boundary.sh`, `bash scripts/check-api-key-boundary.sh`,
  `bash scripts/check-test-spawn-sync.sh`, `bash scripts/check-audit-columns.sh`, `bun run check:dep-graph`
- `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`

## Todo

- [x] Phase 1: Mono file kind icons (ad69b7f8c)
- [x] Phase 2: Frontmatter (f1b771bfb)
- [x] Phase 3: Outline in the right panel (22c681e6e)
- [x] Phase 4: agent-fs favorites (4f8fbec20)
- [x] Phase 5: Row menu, tooltip, copy path (e2c4b0c49)
- [x] Phase 6: Write actions (c22cf78a9)
- [x] Phase 7: Tree filter (90fc0c032)
- [x] Phase 8: Folder filter (ff77df150)
- [x] Phase 9: Search (0b6805119)
- [x] Phase 10: Assets (cf96084ff)
- [x] Docs (05ef2e62e)
- [ ] QA, review, gates, PR

## Log

- 18:44 BCN: #2420 merged. New worktree `~/worktrees/agent-swarm/2026-10-25-comb-browse` off
  origin/main 9c2afc7d8. Old worktree removed.
- 19:10 BCN: research done (agent-fs live UI and core ops), 4 decisions asked and answered.
- 20:00 BCN: Phases 1 to 10 and docs committed. Stack in `/tmp/comb-browse/` (agent-fs 47433, API
  43013, UI 45274, main-branch UI 45275 from `/tmp/comb-browse/main-wt` for before shots).
- QA findings fixed on the way: tree row button took name width (now overlays on hover), the
  grid wrapper broke the grid height (now `contents`), a folder name over a file leaked the
  storage path (now caught first, and 5xx messages are generic), URL-bound text boxes dropped
  keys (React Router updates in a transition: boxes keep local state, `useUrlDraft`),
  Streamdown unwraps an image alone in its paragraph (the frame carries the image's lines),
  toolbar buttons were see-through on white images in dark mode, phone header overflow.
- Known limit: the agent-fs live UI drops the line stamps of a mermaid block
  (`MermaidDiagram` gets no props), so a Comb comment on a diagram shows as Lost there. Image
  comments resolve there (react-markdown keeps the `<p>`). Not fixed here: no agent-fs changes.
- 20:20 BCN: two-axis review (Standards and Spec, Opus). Fixed: Shift+Tab focus escape, the folder
  filter following links to other folders, rename text and checks (agent-fs `mv` writes a new
  version, the old path keeps its history and comments), Delete in an AlertDialog, favorites
  copied (not moved) from fresh server lists with a per-browser marker, per-star rollback,
  linked-image toolbar clicks, one shared filter box (every word), tree filter 5xx text, mono
  numbers and dates, icon sets reused from the viewer, small cleanups, ContextMenu row in
  apps/ui/CLAUDE.md. Also fixed: the outline listed frontmatter as a heading (pre-existing).
- QA of the fixes: Shift+Tab keeps focus, a folder link resets the filter, a taken rename path
  is refused, the import copies a new dashboard star and does not bring back a removed one.

## Review notes (not fixed)

- The row `...` button is mouse only. Keyboard users open the row menu with the context menu
  key or Shift+F10, which macOS lacks. The file header's `...` covers the open file.
- An image frame carries its line. A line-only comment on a paragraph with an inline image now
  outlines the image instead of the text (quote anchors are not affected).
- Recent and Favorites rows keep their own small menu, not the full file menu.
- In the search box Tab switches modes, so the error's Try again button is mouse only. Enter
  retries a failed search.
