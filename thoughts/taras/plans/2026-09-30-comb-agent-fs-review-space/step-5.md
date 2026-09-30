---
id: step-5
name: Browse + text viewers
depends_on: [step-4]
status: claimed
assignee: comb-v-impl-step-5-20260930T1130Z
claimed_at: 2026-09-30T01:12:34Z
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
- [ ] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/comb/`
- [ ] Typecheck: `bun run tsc:check`
- [ ] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] UI E2E smoke still green: `bun run e2e:ui -- --grep @smoke`

#### Automated QA:
- [ ] Local Comb loop (root.md). Seed as the QA human: `comb-qa/notes.md` (headings, a list, a table, a fenced code block, a relative link to `./other.md`), `comb-qa/other.md`, `comb-qa/src/app.ts` (100 lines), `comb-qa/page.html`, `comb-qa/blob.bin` (random bytes).
- [ ] `agent-browser` opens `/file`, lands on the drive root, expands `comb-qa` in the tree, opens the folder view (DataGrid with 5 rows), and screenshots it.
- [ ] Opens `notes.md`: headings, list, and table render. `agent-browser eval "document.querySelectorAll('[data-line-start]').length"` is greater than 0, and the first heading reports `data-line-start="1"`. The code block is plain `pre`. Clicking the relative link opens `other.md` in Comb (URL stays on the dashboard origin).
- [ ] Opens `app.ts`: 100 numbered rows. Opens `page.html`: shown as source, no rendered HTML. Opens `blob.bin`: fallback with Download.
- [ ] Breadcrumb navigation and browser back/forward work. Screenshots + a short recording uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] Taras checks that the markdown rendering in Comb looks like the rest of the dashboard (typography, spacing).

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
