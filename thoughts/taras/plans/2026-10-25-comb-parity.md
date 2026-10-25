---
date: 2026-10-25T22:30:00Z
topic: "Comb parity with the agent-fs live UI (search, share, viewers, uploads, Send to swarm)"
status: done
branch: feat/comb-parity
worktree: ~/worktrees/agent-swarm/2026-10-25-comb-parity
inputs:
  - thoughts/taras/brainstorms/2026-10-25-agent-fs-onboarding.md (Facts: Comb vs the agent-fs live UI, Q on the parity bar)
  - thoughts/taras/research/2026-10-25-agent-fs-onboarding-open-questions.md
---

# Comb parity with the agent-fs live UI

## Goal

Comb (the swarm drive in the dashboard) gets the five live-UI features that Taras named as the bar
for dashboard links: search (name, full text, semantic), share links, the audio and rendered-HTML
viewers, uploads into the current folder, and a checked "Send N to swarm". Everything stays on the
swarm drive, uses the browser's own `af_` key through `lib/agent-fs/client.ts`, and needs no env
change. agent-fs is read-only reference (v0.18.5, `aecd4c8`).

## Decisions

- One phase per feature, one commit per phase, one PR. The one-shot scope gate (3 phases) is
  overridden by Taras's brief, which asks for one phase per feature (asked).
- Ops and shapes, checked against `~/Documents/code/agent-fs/packages/core/src/ops/`:
  - `find {query, path?, limit?}` returns `{matches: [{path, size, modifiedAt?, score}], total}` (v0.18.5+).
  - `fts {pattern, path?}` returns `{matches: [{path, snippet, rank}], hint?, tookMs}`. FTS5 syntax,
    so the query is sent as quoted literal terms joined by `AND` (live `serializeLiteralFtsQuery`).
  - `search {query, limit?}` returns `{results: [{path, score, snippet, page?, kind?, author?, modifiedAt?}], hint?, tookMs}` (RRF hybrid).
  - `share-create {path, expiresIn?, maxViews?}` returns `{id, kind, url, sharePath, path, expiresIn, expiresAt, maxViews}`. Role: viewer. Feature `share-links`.
  - Folder site share (`kind: "site"`, `/site/<token>/`) for rendered HTML. Feature `html-sites`.
  - Upload: `PUT /orgs/:org/drives/:drive/files/<encoded path>/raw`, `If-None-Match: *` for create-only (409 on a clash), body limit from `/health.maxUploadBytes` (default 50 MiB). Role: editor.
- Snippets carry `<b>` markers from FTS5. Comb parses them into text and highlight parts and never
  uses `dangerouslySetInnerHTML` (the live UI does) (assumed).
- Name search on an agent-fs without `find` shows "Update agent-fs to 0.18.5 or later for name
  search" instead of a glob fallback (assumed, keeps the code small; the swarm pins 0.18.5).
- Share links: files only (folder sites stay in the live UI). Expiry choices 1 hour, 24 hours
  (default), 3 days, 7 days, same as the live UI (assumed).
- HTML: Source stays the default view, so comments keep their line anchors and no public link is
  minted on a plain visit. "Preview" mints a 15-minute site share of the file's folder and shows the
  page in an iframe from the agent-fs origin with `sandbox="allow-scripts allow-forms allow-popups
  allow-popups-to-escape-sandbox allow-modals"` (no `allow-same-origin`, no `allow-top-navigation`)
  and `referrerpolicy="no-referrer"`. A file at the drive root warns first: the share exposes the
  whole drive for 15 minutes (assumed).
- Audio: a new `audio` kind for mp3, wav, flac, aac, m4a, ogg, oga, opus, and any `audio/*` content
  type, through the existing `MediaGate` (presigned URL, else blob up to 100 MB) (assumed).
- Uploads: button plus drag and drop on the folder view, folders keep their structure, 3 at a time,
  create-only. A name clash offers "Keep both" (uploads as `name (1).ext`) or "Skip". No Replace:
  overwriting is editing, which stays in the live UI (assumed, flag for Taras).
- Send to swarm: test live first. Fix only a real defect, else map each failure status to a
  readable message.

## Phases

### Phase 1: Search

- `lib/comb/search.ts` (pure, relative imports): modes, min query length, literal FTS pattern,
  snippet parts, result mapping to one hit shape, unknown-op detection.
- `useCombSearch` in `api/hooks/use-agent-fs.ts` (key `(..., "search", mode, query)`).
- `components/comb/search-dialog.tsx`: header button (tooltip, `/` shortcut) opens a dialog with
  the query, a `SegmentedControl` (Name, Full text, Meaning), and a cmdk list. Enter opens the hit.
- Tests: `lib/comb/search.test.ts`.

Verification:
- `bun test apps/ui/src/lib/comb/search.test.ts`
- `cd apps/ui && bunx tsc -b && bun run lint && bun run check:tokens`

Manual E2E:
- `agent-browser --session comb-parity open "http://localhost:$UI_PORT/file/~/$ORG/$DRIVE/"`, press `/`, type `meeting`, switch the three modes, screenshot each, type `zzzqqq` for no results.

### Phase 2: Share links

- `AgentFsClient.createShare`, `lib/comb/share.ts` (expiry choices, link resolution, labels).
- `components/comb/share-dialog.tsx`: header icon button for files (feature `share-links`), expiry
  control, Create link, then the link with Copy and Open.
- Tests: `lib/comb/share.test.ts`.

Verification:
- `bun test apps/ui/src/lib/comb/share.test.ts`
- `cd apps/ui && bunx tsc -b && bun run lint`

Manual E2E:
- Open `/file/~/$ORG/$DRIVE/docs/notes.md`, click Share, pick 1 hour, Create link, then
  `agent-browser --session comb-share-anon open "<link>"` (fresh context, no key) and screenshot.

### Phase 3: Viewers (audio, rendered HTML)

- `file-kinds.ts`: `audio` and `html` kinds. `media.ts`: `audio` media kind.
- `viewers/audio-viewer.tsx` (MediaGate), `viewers/html-viewer.tsx` (Source | Preview toggle,
  source reuses the text viewer), `lib/comb/html-view.ts` (sandbox constant, site URL, root check).
- `useHtmlSiteUrl` hook (site share cached per folder until 3 minutes before expiry).
- Tests: `file-kinds.test.ts`, `media.test.ts`, `lib/comb/html-view.test.ts`.

Verification:
- `bun test apps/ui/src/lib/comb/file-kinds.test.ts apps/ui/src/lib/comb/media.test.ts apps/ui/src/lib/comb/html-view.test.ts`
- `cd apps/ui && bunx tsc -b && bun run lint`

Manual E2E:
- Open `/file/~/$ORG/$DRIVE/media/tone.wav`, play, `agent-browser eval` the `audio.currentTime > 0`.
- Open `/file/~/$ORG/$DRIVE/site/page.html`, Preview, then `agent-browser eval` inside the frame
  probe: the page script writes whether `parent.document` and `parent.localStorage` threw.

### Phase 4: Uploads

- `AgentFsClient.putRaw` (XHR for progress, key redacted from errors).
- `lib/comb/upload.ts` (pure): target paths, folder-drop inputs, next free name, the queue
  (3 at a time, conflict, keep both, skip, cancel, summary).
- `components/comb/upload-zone.tsx` (drop overlay, Upload button, progress list) in `FolderView`.
- Tests: `lib/comb/upload.test.ts`.

Verification:
- `bun test apps/ui/src/lib/comb/upload.test.ts`
- `cd apps/ui && bunx tsc -b && bun run lint`

Manual E2E:
- Upload with the button (`agent-browser upload`), drag and drop (synthetic `DataTransfer` drop
  via `agent-browser eval`), a file above the limit (rejected before sending), and the same name
  twice (Keep both makes `name (1).ext`, Skip leaves it).

### Phase 5: Send N to swarm

- Live test with a lead row registered: `@swarm` comments on two files, "Send 2 to swarm" from the
  folder, then the 409 (all sent), 403 (no permission), and no-lead cases.
- Fix any defect found. Otherwise map statuses to readable toasts in `send-to-swarm.tsx`.

Verification:
- `bun run test:root -- src/tests/comb-review-batch.test.ts`
- `cd apps/ui && bunx tsc -b && bun run lint`

Manual E2E:
- `curl -s -X POST "http://localhost:$API_PORT/api/comb/review-batches" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"orgId":"'$ORG'","driveId":"'$DRIVE'","commentIds":["<id>"],"scopePath":"/docs/"}'`
  then the same from the UI, and `curl -s "http://localhost:$API_PORT/api/tasks?limit=5" -H "Authorization: Bearer $KEY"`.

## Docs

- `docs-site/content/docs/(documentation)/ui/comb.mdx`: Search, Share, Upload, Audio and HTML.

## Manual E2E (whole feature, local stack)

```bash
# agent-fs from source, local storage, local nomic embeddings
AGENT_FS_HOME=/tmp/comb-parity/afs AGENT_FS_STORAGE_PROVIDER=local SERVER_PORT=$AFS_PORT \
  EMBEDDING_PROVIDER=local EMBEDDING_MODEL=nomic-embed-text-v1.5 AGENT_FS_EMBEDDING_MIGRATION_CPU_SHARE=1 \
  bun run ~/Documents/code/agent-fs/packages/cli/src/index.ts server
# API with a throwaway DB
DATABASE_PATH=/tmp/comb-parity/swarm.sqlite PORT=$API_PORT DESPLEGA_TELEMETRY_ENV=test \
  AGENT_FS_API_URL=http://localhost:$AFS_PORT COMB_ENABLED=true bun run start:http
# UI
cd apps/ui && VITE_API_URL=http://localhost:$API_PORT bunx vite --port $UI_PORT
```

Then walk Phases 1 to 5 at 1440x900 and 390x844 with agent-browser, upload the screenshots to
`qa/agent-swarm/2026-10-25-comb-parity/`, and record search, share, upload in one video.

## Verification (whole PR)

- `bun run check:local`, `bun run lint`, `bun run lint:slop`, `bun run tsc:check:tsc`
- `bun run test:root -- --parallel=4`, `bun run e2e`, `bun run e2e:ui`
- `bash scripts/check-db-boundary.sh`, `bash scripts/check-api-key-boundary.sh`, `bash scripts/check-test-spawn-sync.sh`, `bash scripts/check-audit-columns.sh`, `bun run check:dep-graph`
- `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`

## Todo

- [x] Phase 1: Search (86da4cf90)
- [x] Phase 2: Share links (895a95383)
- [x] Phase 3: Viewers (b220e1602)
- [x] Phase 4: Uploads (073898a3e)
- [x] Phase 5: Send to swarm (08fcf59e9)
- [x] Docs (e1d2b2b56)
- [x] QA walk + screenshots + recording (agent-fs `qa/agent-swarm/2026-10-25-comb-parity/`)
- [x] Code review (Standards + Spec, Opus): fixes in the review commit
- [x] Gates: all green except `script-executor-quickjs` ("caps the binary bodies"), which fails on clean main too (macOS)
- [x] PR #2406, local stack stopped, /tmp cleaned

## Review notes (Minor, not fixed)

- Viewer-role users see an enabled Upload button. Each file then fails with agent-fs's 403
  message ("requires 'editor' role"). Comb has no role read to hide it.
- Audio with no extension and no `audio/*` type opens in the fallback viewer. The live UI sniffs
  magic bytes. Not ported.
- `putRaw` (409, 413, abort, redaction) and the feature gates have no unit tests. They were
  checked live (409 clash, abort via cancel path in the queue tests, gates by reading).
- github-attach is not installed on this machine, so the PR embeds agent-fs signed URLs (7 days)
  and a share-create link for the recording.

## Log

- Local stack (scripts in `/tmp/comb-parity/`): agent-fs from source on 47433 (local storage,
  nomic embeddings, home `/tmp/comb-parity/afs`), API on 43013 (DB `/tmp/comb-parity/swarm.sqlite`),
  UI on 45274 (`VITE_PROXY_TARGET=http://127.0.0.1:43013`, dashboard API URL = UI origin). Seed:
  `/tmp/comb-parity/seed/{gen.py,upload.ts,op.ts}`. agent-browser session `comb-parity`.
- Send to swarm, live (before any change): folder batch of 3 `@swarm` comments answered 201 and
  posted the "sent" replies. With no lead the task sat `unassigned` while the toast read like a
  normal success. With a lead it was `pending` on the lead. Re-send: 409 "Nothing to send" with
  `already-sent`. Unknown id: 409 `not-found`. Other drive: 400. Bad id: 400. No defect found.
- Phase 5 change: the result now says who got the task (`lead: online | offline | none`), the toast
  says when no lead or an offline lead got it, and each failure status maps to a plain title.
- Decision: keep the 502-for-the-whole-batch rule (no partial sends). The toast now says nothing was sent.
- Context warning at 52% (hook asked for AskUserQuestion). Continued because the brief says
  autopilot with no checkpoints; this log is the handoff if the session dies.
