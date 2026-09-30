---
id: step-6
name: Media + table viewers
depends_on: [step-5]
status: done
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
- [x] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/comb/csv.test.ts`
- [x] Typecheck: `bun run tsc:check`
- [x] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`

#### Automated QA:
- [x] Local Comb loop (root.md, local storage adapter, so the blob fallback path runs). Seed `comb-qa/media/pic.png`, `clip.mp4`, `doc.pdf`, `data.csv` (with a quoted comma), `data.tsv` using `agent-fs write <path> --file <local file>` (binary-safe). `agent-browser` opens each one and screenshots it: the image shows, the video element has a duration (`agent-browser eval "document.querySelector('video').duration > 0"`), the PDF iframe loads, the CSV grid shows the quoted comma in one cell, and the Source toggle shows the raw text.
- [x] Presigned path: run the local compose stack (`docker compose -f docker-compose.local.yml up`, MinIO backend with `S3_PUBLIC_ENDPOINT=http://localhost:9000`) or point at a MinIO-backed agent-fs, and confirm the image `src` is a `http://localhost:9000/...` presigned URL, not a `blob:` URL. If MinIO CORS blocks nothing here (media tags need no CORS), record that in the step notes.
- [x] Navigating between two images does not leak object URLs: `agent-browser eval` counts `blob:` sources after 5 navigations (only the current one remains in the DOM).

#### Manual Verification:
- [ ] Taras opens one real PDF and one video from the prod drive after rollout (Tigris presigned path).

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.

## Implementation Notes

Commit `0229307fb` on `comb/s6-media-viewers` (worktree `/Users/taras/worktrees/agent-swarm/2026-09-30-comb-s6`, based on step-5 tip `7fefd492d`). Evidence in `/tmp/comb-run/step-6/` (14 screenshots, `media-viewers.webm`, 77 s).

Verification notes:
- Local loop (local storage adapter, so the blob fallback ran): every media element had a `blob:http://localhost:3261/...` source. The video duration was about 3 s. The PDF rendered in Chrome's PDF viewer. The CSV grid showed `London, UK` in one cell. Source showed 4 `div[data-line-start]` rows.
- The harness blocks `agent-browser eval`. `agent-browser wait --fn "<expr>"` runs the same checks (video duration, image `naturalWidth`, a `fetch()` probe of an old object URL).
- Leak check: after 5 navigations between `pic.png` and `pic2.png`, the DOM held 1 `blob:` source. A `fetch()` of the first image's object URL failed (revoked). The current one answered (alive).
- Presigned path: a standalone MinIO container (`minio/minio:latest`, host port 9406, not the compose stack on 9000, to avoid port collisions with other agents). The same agent-fs home restarted with `AGENT_FS_STORAGE_PROVIDER=minio`, `S3_ENDPOINT` = `S3_PUBLIC_ENDPOINT` = `http://localhost:9406`, and the files were written again (v2 in MinIO). The image, video, and PDF sources were `http://localhost:9406/agentfs/...?X-Amz-...` presigned URLs. The PDF URL carries `response-content-disposition=inline`. The MinIO bucket had no CORS rules, and nothing was blocked: `<img>`, `<video>`, and `<iframe>` need no CORS.
- Live switch: the open `pic2.png` view moved from the v1 `blob:` URL to the v2 presigned URL when `stat` polled the new version, with no reload, and the DOM then had 0 `blob:` sources.
- Also checked: the error state (a `.png` with text bytes shows "Could not show this image" with Download and Open in agent-fs), the 5,000-row notice on a 6,000-row CSV (50 pages of 100), numeric sort (ID descending starts 5000, 4999), light mode, and 390 px width.

Decisions and deviations:
- Two queries instead of one: `signed-url` (default-ish cache, so a reopened file reuses the URL and the browser's HTTP cache) and `raw` (only when `signed-url` answers 422 or `kind: "app"`, `gcTime: 0`). A query's `gcTime` is fixed when it is created, so "gcTime 0 for the blob branch" needs its own query.
- The object URL is created and revoked in a component effect from the query's `Blob` (same lifecycle as `task-attachments-section.tsx`), not inside `queryFn`. React-query has no hook to revoke a URL when it drops a cached value.
- Keys follow the step-4 contract: `[..., orgId, driveId, "media", path, revision, "signed-url", disposition]` and `[..., "media", path, revision, "raw"]` (the plan wrote `agentFsKey(endpoint, userId, "media", path)`). The revision makes a new version mint a new URL or load new bytes. Both keep the previous media of the same file on screen while the next revision loads.
- Re-fetch before expiry: `staleTime` is 50 min, but the URL on screen never changes (`refetchInterval: false`, `refetchOnWindowFocus: false`, `gcTime` 10 min). A new URL reloads a PDF at page 1 and restarts a video. Every new mount after 50 min mints a new URL. Known gap: a video kept open for more than 1 h fails when it seeks past the buffer, and shows the error state.
- `useAgentFsMediaUrl(target, {disposition, type})` gained a `type` option. `PdfViewer` passes `application/pdf`. An object URL has the dashboard's origin, so a frame must never render a sniffed `text/html` blob there. The `.pdf` extension picks the viewer, not the stored content type.
- New shared `viewers/media-gate.tsx` (`MediaGate`), the media twin of `TextGate`: skeleton, hook error, and element `onError`, plus Download and Open in agent-fs. It remembers the failed URL, so a new URL (a new version) tries again.
- Table: ragged rows longer than the header get extra "Column N" columns. Empty files show an empty state. Page size is 100. A numeric-aware collator sorts cells (AG Grid otherwise sorts "10" before "2"). Not in the plan, one line.
- The parser also drops a UTF-8 BOM and skips lines with no characters. Parsing stops once it knows the table has more than 5,000 rows.
- `file-viewer.tsx`: besides the four entries, the stale "Step-6 points ..." comment line was removed.
- The image toggle changes its label ("Show actual size" / "Fit to width"), so it has no `aria-pressed`. The zoom cursor is on the `<img>`, because the global unlayered button cursor rule wins over utilities on the button.

Notes for later steps:
- `useAgentFsMediaUrl(target, {disposition?, type?})` in `api/hooks/use-agent-fs.ts` returns `{url, source: "presigned" | "blob" | null, error}`. Step-11: invalidate media for a path by the prefix `agentFsKey(endpoint, userId, orgId, driveId, "media", path)`. A `stat` refetch already moves the revision, so invalidating `stat` is enough for a new version.
- `MediaGate({file, noun, type?, children: (url, onError) => node})` in `viewers/media-gate.tsx`.
- `parseDelimited(text, {delimiter?, maxRows?})`, `delimiterFor(path)`, `CSV_MAX_ROWS` in `lib/comb/csv.ts` (relative imports only, root-test safe).
- The table toolbar is `data-comb-skip` and sticky. In Source mode the rows are the step-5 `TextLines` rows, so step-7 anchoring works unchanged. The Table/Source choice is component state and resets per file.
- Integration follow-up (orchestrator note): the step-5 fix adds a markdown `img` placeholder with a `// step-6:` comment. Wire relative drive images to `useAgentFsMediaUrl` at integration. The step-5 fix also moves `DownloadButton` to a signed URL. Its presigned-support check and this hook both call `signed-url`. They can share code later if it helps.

### Review fixes

Commit `c74d8d829` on `comb/s6-media-viewers` (on top of `0229307fb`). Evidence in `/tmp/comb-run/step-6/fix-*.png`. The notes above describe the first commit. Where they differ, this section wins.

Security (blob URLs have the dashboard's origin, the dashboard has no CSP, and localStorage holds the swarm key and the `af_` key):
- Rule (`blobUrlPlan` in `lib/comb/media.ts`, documented there): raster images and video get `application/octet-stream`, a PDF gets `application/pdf`, and SVG gets a `data:image/svg+xml` URL. The stored content type is never used. The type is applied when the URL is created (`useObjectUrl(blob, type)` uses `Blob.slice`, no copy). The cached raw Blob and the raw query key do not depend on the viewer kind.
- Browser checks (local storage adapter, blob mode, Chrome through agent-browser):
  - `evil.svg` (an SVG with a `<script>` that sets `document.title` and writes a `comb-xss-svg` localStorage marker): the `<img>` renders from a `data:image/svg+xml;base64` URL. A page-initiated `location.href = img.src` is blocked by Chrome (the tab stays on the dashboard). A browser-initiated open of the same URL in a new tab runs the script in origin `null`, and its localStorage write throws ("SVG-SCRIPT-RAN origin=null storage-blocked"). No marker in the dashboard's localStorage.
  - `x.png` (created with `agent-fs mv page.html x.png`, stored type `text/html`, the raw route also answers `text/html`): the object URL has type `application/octet-stream`. The `<img>` fails and shows "Could not show this image". Opening that object URL in a new tab downloads the 302-byte file (the tab closes, no document renders). A page-initiated `location.href` to it leaves the dashboard in place. No marker in localStorage, title unchanged.
  - Negative control (proves the probe works): an object URL of the same raw bytes with the stored type (`text/html`, what the first commit did for images) opened in a new tab ran the script at `http://localhost:3261` and wrote the `comb-xss-html` marker into the dashboard's localStorage. The marker was removed afterwards.
  - `pic.png` renders from an `application/octet-stream` object URL (`naturalWidth` 1600). `clip.mp4` plays from one (`duration` 3). `doc.pdf` loads in the PDF viewer from an `application/pdf` object URL.

Other fixes:
- Blob mode stops at `COMB_MEDIA_MAX_BYTES` (100 MiB): `MediaGate` shows `FallbackViewer tooLarge`. Checked with a 110 MB `big.mp4` (agent-fs restarted with `AGENT_FS_MAX_UPLOAD_BYTES=209715200`, the default cap is 50 MiB): the fallback showed, and agent-fs logged no GET of its `/raw`. Presigned URLs have no cap.
- `mediaSourceFrom`, `freshPresignedUrl`, and `blobUrlPlan` are pure and unit-tested (`lib/comb/media.test.ts`).
- The signed-url query stores `{kind: "presigned", url, expiresAt}` with `expiresAt` = mint time + `expiresIn` on the browser's clock. `staleTime` is a function that makes the URL stale 5 minutes before expiry. The hook hides a URL that is inside the margin at mount (`mountedAt`), so a reopened file shows the skeleton and a new URL, never an expired one. A URL already on screen stays. Not browser-tested (it needs a clock jump). The unit tests cover the margin.
- Data wins over an error: a presigned or blob URL is returned before any query error.
- Table: `compareCells` in `lib/comb/csv.ts` compares two finite numbers by value, else uses the numeric collator. Browser: `numbers.csv` sorted `-10 -2 1.25 1.5 2 10 abc` ascending and the reverse descending. At most `CSV_MAX_COLUMNS` (500) columns (`aria-colcount` 500 for a 600-column file). The notice lists what was cut ("5,000 rows and 500 columns") and shows only in Table view. `delimiterFor(path, text)`: `.csv` picks the most frequent of comma, semicolon, and tab outside quotes on the header line (comma on a tie). A semicolon export showed `Smith, J`, `1,5`, and `Rome; IT` in their own cells.
- The image button label includes the file name (`pic.png, show actual size` / `pic.png, fit to width`).
- `MediaGate` doc comment: a PDF frame cannot report load errors, so its error state covers loading the URL only.
- Removed `source` from the hook result and the `disposition` option. The API is now `useAgentFsMediaUrl(target, kind)`.
- `fileRevision(stat)` and `keepSameFile(fileKey)` are private helpers in `use-agent-fs.ts`. `useAgentFsText` uses them (two one-line edits, to ease the merge with the step-5 fix).
- `useObjectUrl` moved to `hooks/use-object-url.ts` (with `useDataUrl`). `composer-dock.tsx` `AttachmentIcon` uses it (a trivial swap, same behavior, no type forcing there: those are the user's own local files).
- Presigned re-check: agent-fs restarted on a throwaway MinIO container (host port 9406, bucket created with `mc mb`). The image, video, and PDF sources were `http://localhost:9406/agentfs/...` presigned URLs. The PDF URL carried `response-content-disposition=inline`.

Updated notes for later steps (replace the first-commit notes above):
- `useAgentFsMediaUrl(target, kind: MediaKind)` returns `{url, tooLarge, error}`. Keys: `[..., "media", path, revision, "signed-url"]` and `[..., "media", path, revision, "raw"]`. Invalidate by the prefix `(..., "media", path)`. For the markdown image placeholder, call it with `"image"`.
- `MediaGate({file, stat, kind, children: (url, onError) => node})`.
- `lib/comb/media.ts`: `MediaKind`, `COMB_MEDIA_MAX_BYTES`, `MEDIA_URL_EXPIRY_MARGIN_MS`, `MediaSource`, `mediaSourceFrom`, `freshPresignedUrl`, `blobUrlPlan`.
- `lib/comb/csv.ts`: `delimiterFor(path, text)`, `compareCells`, `CSV_MAX_COLUMNS`.
- `hooks/use-object-url.ts`: `useObjectUrl(blob, type?)`, `useDataUrl(blob, type)`. Any new object URL of drive bytes must go through `blobUrlPlan` (or force a non-document type). `DownloadButton` in `file-actions.tsx` (step-5) makes a raw-typed object URL for an `<a download>`, which downloads and does not render, so it is safe as is.
- Known gap: Safari was not tested. The octet-stream rule relies on the browser sniffing images and video (verified in Chrome only).
