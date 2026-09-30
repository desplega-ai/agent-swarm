---
id: step-6
name: Media + table viewers
depends_on: [step-5]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-6: Media + table viewers

**Repo:** agent-swarm. Replaces the `image`, `video`, `pdf`, and `table` entries of the `VIEWERS` table in `apps/ui/src/components/comb/viewers/file-viewer.tsx` (step-5). Works against agent-fs v0.14.0.

## Overview

Comb renders images, videos, PDFs, and CSV/TSV files. Media loads from a presigned signed URL when the agent-fs storage backend supports it (prod Tigris allows cross-origin reads, research "Open Questions"). Otherwise, for example on the local adapter, it loads through the Bearer `/raw` route into a blob object URL. CSV/TSV files render as a `DataGrid` table with a "Source" toggle that shows the text viewer (so line comments from step-7 work on CSV source too).

When done: every v1 file type in the brainstorm (Q15) renders in the dashboard.

## Changes Required:

#### 1. Media URL hook
**File**: `apps/ui/src/api/hooks/use-agent-fs.ts`
**Changes**: `useAgentFsMediaUrl(path, {disposition: "inline"})`:
- Call the `signed-url` op with `disposition: "inline"` and `expiresIn: 3600`. When the result has `kind: "presigned"`, use the URL. Re-fetch before expiry (`staleTime` 50 min).
- When the op fails (422 `UnsupportedOperation`) or returns `kind: "app"`, fall back to `fetchRaw` → `URL.createObjectURL`. Revoke the object URL on path change and unmount (same lifecycle as `task-attachments-section.tsx:279-302`).
- Key: `agentFsKey(endpoint, userId, "media", path)`. Mark the query with `gcTime: 0` for the blob branch so object URLs are not cached across files.

#### 2. Media viewers
**File**: `apps/ui/src/components/comb/viewers/image-viewer.tsx`, `video-viewer.tsx`, `pdf-viewer.tsx` (new)
**Changes**: `<img>` (fit to width, click toggles 100%), `<video controls preload="metadata">`, `<iframe title=... src=...>` for PDF (inline disposition). Loading skeleton and an error state with Download + "Open in agent-fs". Mirror `live/` component names (`ImageViewer`, `VideoViewer`, `PdfViewer`). SVG loads through `<img>` only (scripts in SVG do not run there).

#### 3. Table viewer
**File**: `apps/ui/src/lib/comb/csv.ts` (new)
**Changes**: small RFC 4180 parser (quoted fields, escaped quotes, CRLF and LF, trailing newline, a custom delimiter for TSV). Returns `{header, rows, truncated}` with a cap of 5,000 rows. No new dependency.

**File**: `apps/ui/src/components/comb/viewers/table-viewer.tsx` (new)
**Changes**: loads text with `useAgentFsText` (2 MiB cap), parses, renders `DataGrid` with one column per header cell. A "Table | Source" toggle; Source renders the step-5 text viewer. Shows "Showing first 5,000 rows" when truncated.

**File**: `apps/ui/src/components/comb/viewers/file-viewer.tsx`
**Changes**: point the four `VIEWERS` entries at the new components. No other change to this file.

#### 4. Tests
**File**: `apps/ui/src/lib/comb/csv.test.ts` (new)
**Changes**: quoted commas, escaped quotes, embedded newlines inside quotes, CRLF, TSV, empty file, ragged rows, the 5,000-row cap.

### Success Criteria:

#### Automated Verification:
- [ ] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/comb/csv.test.ts`
- [ ] Typecheck: `bun run tsc:check`
- [ ] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`

#### Automated QA:
- [ ] Local Comb loop (root.md, local storage adapter, so the blob fallback path runs). Seed `comb-qa/media/pic.png`, `clip.mp4`, `doc.pdf`, `data.csv` (with a quoted comma), `data.tsv` using `agent-fs write <path> --file <local file>` (binary-safe). `agent-browser` opens each one and screenshots it: the image shows, the video element has a duration (`agent-browser eval "document.querySelector('video').duration > 0"`), the PDF iframe loads, the CSV grid shows the quoted comma in one cell, and the Source toggle shows the raw text.
- [ ] Presigned path: run the local compose stack (`docker compose -f docker-compose.local.yml up`, MinIO backend with `S3_PUBLIC_ENDPOINT=http://localhost:9000`) or point at a MinIO-backed agent-fs, and confirm the image `src` is a `http://localhost:9000/...` presigned URL, not a `blob:` URL. If MinIO CORS blocks nothing here (media tags need no CORS), record that in the step notes.
- [ ] Navigating between two images does not leak object URLs: `agent-browser eval` counts `blob:` sources after 5 navigations (only the current one remains in the DOM).

#### Manual Verification:
- [ ] Taras opens one real PDF and one video from the prod drive after rollout (Tigris presigned path).

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
