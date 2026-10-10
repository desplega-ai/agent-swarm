---
id: step-5
name: Browse + text viewers
depends_on: [step-4]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-5: Browse + text viewers

**Repo:** agent-swarm. Uses the `AgentFsClient`, `useAgentFs()`, and `use-agent-fs.ts` hooks from step-4. Works against agent-fs v0.14.0.

## Overview

A connected human browses the swarm drive in Comb and reads text files. The page gets a tree rail (lazy per folder), a folder view (DataGrid), breadcrumbs, and a file view with a header (version, size, author, Download, "Open in agent-fs"). An extension → viewer table, shaped like `$AFS/live/src/components/viewers/FileViewer.tsx`, routes each file to a viewer. This step ships the markdown viewer, the text/code viewer, and the fallback viewer. Both text viewers stamp `data-line-start` / `data-line-end` on their blocks, so step-7 can anchor comments on them.

When done: every folder and text file in the drive opens in the dashboard, and links between markdown files in the drive stay in Comb.

## Changes Required:

#### 1. Paths and file kinds
**File**: `apps/ui/src/lib/comb/paths.ts` (new)
**Changes**: parse the splat into `{orgId, driveId, path, isFolder}` (a trailing `/` or empty path means folder). `combPath({orgId, driveId, path})` builds `/file/~/<org>/<drive>/<encoded path>` with per-segment `encodeURIComponent` that preserves existing `%HH` escapes (same rule as `buildAgentFsLiveUrl`, `src/utils/constants.ts:135-138`). `resolveRelative(fromFilePath, href)` for relative markdown links.

**File**: `apps/ui/src/lib/comb/file-kinds.ts` (new)
**Changes**: `getFileKind(name, contentType?)` → `markdown | text | image | video | pdf | table | fallback`. Extension lists copied from `live/` `FileViewer.tsx` (images :47, video :51, `BINARY_EXTS` :55-65, `TEXT_EXTS` :108-113). `md`/`mdx` → markdown. `csv`/`tsv` → table. `html`/`htm` → text (source only). Unknown extension with a text-like content type → text.

#### 2. Data hooks
**File**: `apps/ui/src/api/hooks/use-agent-fs.ts`
**Changes**: add `useAgentFsStat(path)`, `useAgentFsText(path, {maxBytes})` (`fetchRaw` → `blob.text()`, skipped above `maxBytes` = 2 MiB with a `tooLarge` result), and folder listing via `useAgentFsLs(path)`. Keys follow `agentFsKey(endpoint, userId, "stat" | "content" | "ls", path)` so step-11 can invalidate them by path. Folder detection: when `stat` answers not-found and `ls` succeeds, redirect to the trailing-slash URL (`replace`).

#### 3. Layout, tree, folder view, file header
**File**: `apps/ui/src/pages/comb/page.tsx`
**Changes**: the `ready` body becomes a two-pane layout: `components/comb/tree-rail.tsx` on the left, main pane on the right. Keep the connect/disabled states from step-4.

**File**: `apps/ui/src/components/comb/tree-rail.tsx` (new)
**Changes**: lazy tree over `ls` (expand loads children), current path highlighted, folders first then files, keyboard navigation (arrow keys, Enter). Collapsible on narrow screens.

**File**: `apps/ui/src/components/comb/folder-view.tsx` (new)
**Changes**: `DataGrid` (`@/components/shared/data-grid`, mandated by `apps/ui/CLAUDE.md`) with columns name, type, size, modified, author. Row click navigates. Phone layout uses `MobileList` per `apps/ui/CLAUDE.md`. `EmptyState` for an empty folder.

**File**: `apps/ui/src/components/comb/breadcrumbs.tsx`, `apps/ui/src/components/comb/file-header.tsx` (new)
**Changes**: breadcrumbs from the path. Header shows name, `v<currentVersion>`, size, author, modified time, Download (raw blob → `a[download]`), and "Open in agent-fs" (`<liveUrl>/file/~/<org>/<drive>/<path>`, new tab, `liveUrl` from `/status` comb block).

#### 4. Viewers
**File**: `apps/ui/src/components/comb/viewers/file-viewer.tsx` (new)
**Changes**: `VIEWERS: Record<FileKind, LazyExoticComponent>`, one entry per kind, lazy-loaded. In this step `image`, `video`, `pdf`, and `table` map to the fallback viewer (step-6 replaces those entries). Comment on the table: "Add a viewer = one entry + one component, same as live/ FileViewer".

**File**: `apps/ui/src/lib/comb/rehype-source-lines.ts` (new)
**Changes**: port `rehypeSourceLines` from `$AFS/live/src/lib/dom-text-space.ts:164-178`: stamp `data-line-start` / `data-line-end` from `node.position` on block elements (same block tag list). Credit the source file in a header comment.

**File**: `apps/ui/src/components/comb/viewers/markdown-viewer.tsx` (new)
**Changes**:
- `<Streamdown mode="static" parseIncompleteMarkdown={false} rehypePlugins={...} components={COMB_MD_COMPONENTS}>`. Do NOT change `MarkdownView` (`apps/ui/src/components/shared/markdown-view.tsx`), which other pages use.
- Plugin order: Streamdown's rehype props replace its defaults, and `defaultRehypePlugins` is exported (research, "Streamdown internals"). Start with `[...defaultRehypePlugins, rehypeSourceLines]`. If the test in section 5 shows positions are lost after `rehype-raw` / `rehype-sanitize`, switch to `[rehypeSourceLines, ...defaultRehypePlugins]` and extend the sanitize schema so `data-line-start` / `data-line-end` survive. The test decides. Record the chosen order in a code comment.
- `COMB_MD_COMPONENTS`: fenced code renders as plain `<pre><code>` text (NOT Monaco, whose DOM is not plain text nodes). Inline code keeps the chip style. `a`: a relative href resolves with `resolveRelative` and renders a router `Link` to the Comb path. Other links keep `target="_blank" rel="noreferrer"` (step-13 rewrites agent-fs live links).
- Mark Streamdown chrome that adds text (code block header, action buttons, table toolbar) with `data-comb-skip`, or confirm it carries a `data-streamdown` value step-7 can skip. Pass `controls={false}` if it removes the buttons.

**File**: `apps/ui/src/components/comb/viewers/text-viewer.tsx` (new)
**Changes**: one row per line: `<div data-line-start={n} data-line-end={n}>`, a line-number gutter marked `aria-hidden` + `data-comb-skip` + `select-none`, and the line text as a plain text node. Monospace, horizontal scroll, no syntax highlighting (plan decision). Above 20,000 lines show the first 20,000 plus a "truncated, download for the full file" notice.

**File**: `apps/ui/src/components/comb/viewers/fallback-viewer.tsx` (new)
**Changes**: file metadata, Download, "Open in agent-fs", and "Too large to preview" when `tooLarge`.

#### 5. Tests
**File**: `apps/ui/src/lib/comb/rehype-source-lines.test.tsx` (new, `bun:test` + `renderToStaticMarkup`)
**Changes**: render a markdown document through the Comb markdown viewer config. Assert document-absolute `data-line-start` / `data-line-end` on: a heading at line 1, a paragraph after a fenced code block, a list item, a table, and a paragraph after a raw HTML block. Assert fenced code renders as `<pre><code>` without Monaco.

**File**: `apps/ui/src/lib/comb/paths.test.ts`, `apps/ui/src/lib/comb/file-kinds.test.ts` (new)
**Changes**: splat parsing, folder detection by trailing slash, encoding with `%HH` preserved, `resolveRelative` (`./b.md`, `../x/c.md`, `#anchor`, absolute URLs untouched). File kinds for each extension group, `.html` → text.

### Success Criteria:

#### Automated Verification:
- [x] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/comb/`
- [x] Typecheck: `bun run tsc:check`
- [x] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [x] UI E2E smoke still green: `bun run e2e:ui -- --grep @smoke`

#### Automated QA:
- [x] Local Comb loop (root.md). Seed as the QA human: `comb-qa/notes.md` (headings, a list, a table, a fenced code block, a relative link to `./other.md`), `comb-qa/other.md`, `comb-qa/src/app.ts` (100 lines), `comb-qa/page.html`, `comb-qa/blob.bin` (random bytes).
- [x] `agent-browser` opens `/file`, lands on the drive root, expands `comb-qa` in the tree, opens the folder view (DataGrid with 5 rows), and screenshots it.
- [x] Opens `notes.md`: headings, list, and table render. `agent-browser eval "document.querySelectorAll('[data-line-start]').length"` is greater than 0, and the first heading reports `data-line-start="1"`. The code block is plain `pre`. Clicking the relative link opens `other.md` in Comb (URL stays on the dashboard origin).
- [x] Opens `app.ts`: 100 numbered rows. Opens `page.html`: shown as source, no rendered HTML. Opens `blob.bin`: fallback with Download.
- [ ] Breadcrumb navigation and browser back/forward work. Screenshots + a short recording uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] Taras checks that the markdown rendering in Comb looks like the rest of the dashboard (typography, spacing).

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.

## Implementation Notes

Commit `ac4ed7c24` on `feat/comb-2-browse` (worktree `/Users/taras/worktrees/agent-swarm/2026-09-30-comb-browse`, stacked on step-4 `19e52d7aa`). Evidence in `/tmp/comb-run/step-5/` (13 screenshots, `browse-flow.webm`). The last Automated QA box stays open until the orchestrator uploads the evidence. Breadcrumbs, back, and forward were verified.

Verification notes:
- The `[data-line-start]` count check used `agent-browser get count` (the harness blocks `eval`): 15 stamped blocks on `notes.md`, `article h1` reports `data-line-start="1"`, one `pre > code`, no Monaco block.
- `app.ts`: 100 `div[data-line-start]` rows, the last reports `data-line-end="100"`. `page.html`: 7 source rows, no `h1` and no `script` in the content pane. `blob.bin`: the fallback Download saved 4096 bytes whose SHA-256 matches the agent-fs content hash.
- Tree keyboard: Down, Right (open), Right (first child), Left (parent), Enter (opens `app.ts`).
- UI E2E smoke: 34 passed, 17 skipped, `/file` passed on the first run.

Rehype plugin order (step-7 depends on it): `[raw, sanitize, rehypeSourceLines]`, in `components/comb/viewers/comb-markdown.tsx`.
- Stamping first loses the stamps: `rehype-sanitize` strips `data-line-*` (checked).
- `rehype-raw` and `rehype-sanitize` keep hast positions: the paragraph after a raw HTML block reports its real line (unit test).
- `rehype-harden` is left out. With Streamdown's options it rewrites `./b.md` to `/b.md` and replaces a bare `b.md` link with a `[blocked]` span. Sanitize already limits `href` / `src` protocols (a unit test proves `javascript:` links and `<script>` are dropped).

Decisions and deviations:
- Hooks take a `DrivePath` (`{orgId, driveId, path}`) from the route, per the orchestrator's new key contract. Keys: `["agent-fs", endpoint, userId, orgId, driveId, kind, path]`. `useAgentFsLs(path)` became `useAgentFsLs(target)`. `agentFsKey` keeps its step-4 signature in this branch; the calls pass org and drive in positions 3 and 4, so the key shape already matches the new contract.
- Retry: no retry for any 4xx (a superset of "401 is never retried"). A missing file therefore answers at once.
- `useAgentFsText` keys the bytes by revision (`[..., "content", path, currentVersion ?? etag ?? modifiedAt]`), `staleTime: Infinity`, no polling, `gcTime` 5 min. `stat` polls, so a new version refetches. The previous version stays on screen only for the same file.
- Folder detection: `stat` 404 is not enough. `ls` of a missing folder answers `[]`, so the redirect needs at least one entry. The local storage backend also answers `stat` for a directory (200, no `currentVersion`), so an unversioned `stat` also triggers the folder probe.
- The markdown renderer lives in `viewers/comb-markdown.tsx` (relative imports only) so `bun:test` can render it from the repo root. `markdown-viewer.tsx` wraps it with the text loader.
- Added `useDriveMembers({orgId, driveId})` now (step-8's spec shape plus a drive argument) to show authors by name. It is gated on the `drive-members` feature. Without it, authors show as an 8-character id prefix.
- Added `lib/comb/tree.ts` (flat ARIA tree rows, natural sort) with a small test. Not in the plan: it keeps keyboard navigation as index math.
- New shared `lib/format-bytes.ts`. The three older local copies stay untouched.
- The layout header breadcrumb collapses `/file/...` to "Comb". The in-page trail sits in the page's `PageHeader` title, in one row with Disconnect. The "Connected as" badge hides below `sm`.
- The text viewer does not count a final newline as a line and splits on CRLF.
- QA gotcha: a fresh swarm DB redirects every route to `/setup`. Open `/file?fromSetup=1` once per page load.

Notes for later steps:
- Paths (`lib/comb/paths.ts`): `DrivePath`, `CombLocation` (`+ isFolder`), `parseCombSplat`, `combPath`, `resolveRelative` (returns `{path, suffix}` or null), `baseName`, `parentFolder`, `ancestorFolders`, `childPath`, `isFolderPath`. Folder paths end with "/" and the root is "/". Step-12 adds `pinIdFor` / `parsePinId` here.
- Kinds: `getFileKind(name, contentType?)` in `lib/comb/file-kinds.ts`.
- Hooks (`api/hooks/use-agent-fs.ts`): `useAgentFsAccess()`, `agentFsLsQuery(access, target)`, `useAgentFsLs`, `useAgentFsStat`, `useAgentFsText(target, {maxBytes})` → `{tooLarge, text}`, `useDriveMembers`, `COMB_TEXT_MAX_BYTES`. Invalidate content by the prefix `(..., "content", path)`.
- Viewer contract: `ViewerProps = {file: DrivePath, stat: StatResult}`. Each viewer file default-exports its component. `VIEWERS` in `viewers/file-viewer.tsx` has one entry per kind (step-6 swaps image, video, pdf, table). `TextGate` (in `viewers/text-gate.tsx`) loads text and renders loading, error, and the too-large fallback. `TextLines({text})` is exported from `viewers/text-viewer.tsx` (step-6 table Source toggle). `ViewerSkeleton` is in `viewers/viewer-skeleton.tsx`.
- Mount points: `components/comb/file-view.tsx` `FileBody` has the viewer scroll pane (a `div` with `overflow-auto`) and the marked slot `Comment rail (step-7) mounts here, beside the viewer pane`. Step-7 can put its root ref on that pane. `file-header.tsx` and `folder-view.tsx` each have one marked action slot (step-12 pin). `FileView` is keyed by path in the page, so per-file state resets on navigation.
- Anchoring DOM: markdown blocks `p, h1-h6, li, blockquote, pre, tr, table, hr` carry `data-line-*` (a fenced `pre` spans the fence lines; `th`/`td` do not). Text rows are `div[data-line-start]` with one text node each. Skip `[data-comb-skip]` (text gutter, truncation notice), `button`, and `[data-streamdown="image-fallback"]`. With `controls={false}` Streamdown adds no code or table toolbars. The table sits in a `data-streamdown="table-wrapper"` div with no text.
- Markdown links: `COMB_MD_COMPONENTS.a` is the one place for step-13's live-link rewrite (it already renders a router `Link` for relative links).
- Relative markdown images are not resolved yet. They load from the dashboard origin and show Streamdown's image fallback. (Superseded by the review fixes below: they now render a placeholder.)

### Review fixes

Commit `3db4b19de` on top of `7fefd492d` on `feat/comb-2-browse`. Evidence: `/tmp/comb-run/step-5/fix-*.png`.

What changed, by review item:
1. Link containment (security). `resolveRelative` still applies a literal `.` or `..`, and it stops at the drive root. A segment that decodes to `.` or `..`, or to a name with `/` or `\`, makes the result null (`%2e%2e/`, `.%2e/`, `..%2F..%2Fx`, `..%5C`). `CombLink` renders a null relative link as a plain `<span>` with no href. Before, it fell through to `<a target="_blank">` with the raw href, which also opened a dashboard route in a new tab. `parseCombSplat` drops `.` and `..` segments. New export `isAbsoluteUrl(href)` in `lib/comb/paths.ts`.
2. `combPath` encodes each segment with plain `encodeURIComponent`. `a%20b.md` round-trips.
3. Content queries use `gcTime: 0`, so each revision entry drops as soon as no viewer reads it. `useAgentFsText(target)` no longer takes `{maxBytes}`.
4. File kinds: `htm` is text. `xlsx`, `xlsm`, `pptm`, `docm`, `vsdx` are binary. `isTextContentType` strips parameters and matches only `text/*`, `+json`, `+xml`, and a named set (`application/json`, `application/xml`, `application/javascript`, `application/x-javascript`, `application/typescript`, `application/x-typescript`). Unknown extensions with no type or `application/octet-stream`: live/ opens them as text with no check. Comb follows live/ for the routing (text viewer) only when the file is under 256 KiB (`getFileKind(name, type, size)`), and `TextGate` shows the fallback when the first 8 KiB has a NUL (`needsSniff`, `looksLikeText`). Decision: pure live/ parity dumps binary blobs as text, so the sniff guards it.
5. `FileView`: a 404 renders "File not found" (after the folder probe), never the stale `stat.data`. `FileBody` from `stat.data` stays only for the unversioned case.
6. Tree scroll: the current row scrolls into view once per `currentPath`, as soon as the row exists. Opening another folder does not move the rail.
7. Tree ARIA: the chevron is `aria-hidden="true"` with `tabIndex={-1}` (its `aria-label` is gone). The tree has `aria-busy` while a nested listing loads. Status rows are `aria-hidden` and each describes its folder's treeitem (`aria-describedby`). A root that is loading or failed renders a paragraph instead of an empty tree. `TreeRow` status rows gained a `folder` field.
8. Tests: 20,000-line truncation (`lib/comb/text-lines.test.ts`), 2 MiB `tooLarge` (`lib/comb/text-content.test.ts`), link escapes (paths and rendered markdown), sanitize (`<iframe>`, `on*`, `data:` links, `<style>`). The render test moved to `components/comb/viewers/comb-markdown.test.tsx`. `lib/comb/rehype-source-lines.test.ts` tests the plugin alone on a hand-built hast tree. Seams for testing: `TextLines` renders from `splitTextLines` (`lib/comb/text-lines.ts`), and the text query runs `readDriveText` (`lib/comb/text-content.ts`), because the viewer and hook modules import through `@/`.
9. Polling: in the tree, only the folder in view polls (`isFolder ? path : parentFolder(path)`). Other open folders refetch on open and on window focus.
10. Download: `DownloadButton` asks for `signed-url` with `disposition: "attachment"`. A `presigned` answer downloads through that URL. An `app` answer or an error falls back to the raw blob (local storage). Only the fallback path was tested live (local storage).
11. Markdown images: web images (`http`, `https`, `//`) render as a plain `img`. Streamdown's own image component is not exported, so its hover download button is gone for them. Drive images render a `data-comb-skip` placeholder with the alt text and a Comb link to the file (`// step-6:` marks the spot). The sanitize schema adds `style` to `strip`.
12. `MobileList` meta shows the author.
13. `task-attachments-section.tsx` imports `formatBytes` from `lib/format-bytes.ts`.
14. `remark-frontmatter` is not in the root `bun.lock`. The `rehype-source-lines.ts` header now says Comb has no frontmatter parser: a leading `---` block renders as a rule plus a setext heading with the file's own line numbers (a test checks this). Frontmatter rendering: follow-up.
15. `components/layout/breadcrumbs.tsx:88`: em dash replaced with a comma.

Moved or changed exports (no renames):
- `COMB_TEXT_MAX_BYTES` and type `AgentFsText` now live in `lib/comb/text-content.ts`. `api/hooks/use-agent-fs.ts` re-exports both.
- `TEXT_VIEWER_MAX_LINES` now lives in `lib/comb/text-lines.ts`. `viewers/text-viewer.tsx` re-exports it. `TextLines` stays in `text-viewer.tsx`.
- `useAgentFsText(target)` (the `{maxBytes}` option is gone). `getFileKind(name, contentType?, size?)` (new optional `size`).
- New: `isAbsoluteUrl` (paths), `needsSniff`, `looksLikeText`, `SNIFF_MAX_BYTES` (file-kinds), `readDriveText`, `splitTextLines`.

Verification: 96 targeted tests pass (`lib/comb`, `lib/agent-fs`, `components/comb`, `query-persistence`). `bun run tsc:check`, `apps/ui` `bun run lint`, `bunx tsc -b`, and `check:tokens` pass. Browser re-QA (session `comb-s5`, API 3250, UI 3251, agent-fs 7405): the three escape links render as plain text and a click keeps the URL, `page.htm` (octet-stream) shows 8 source rows, `README` (octet-stream) shows text, `blob.dat` shows the fallback, expanding `aaa-other` with the rail scrolled up leaves the rail at the top, and `rm` through the CLI shows "File not found" 11 s later (one 10 s poll). The README download through the blob fallback matches the seed bytes.
