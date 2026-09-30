---
date: 2026-09-29T21:40:00+02:00
researcher: Claude
git_commit: ae8aaf2f877bf68da12263f51397ad653e16304a
branch: worktree-brainstorm-agent-fs-space
repository: agent-swarm (+ sibling agent-fs @ 08e7d89, v0.14.0)
topic: "Comb: open questions for an agent-fs review space in the swarm dashboard"
tags: [research, agent-fs, ui, realtime, comments, mentions, comb]
status: complete
autonomy: autopilot
last_updated: 2026-09-29
last_updated_by: Claude
---

# Research: Comb open questions (agent-fs review space in the swarm dashboard)

**Date**: 2026-09-29
**Researcher**: Claude
**Git Commit**: agent-swarm `ae8aaf2f8` · agent-fs `08e7d89` (v0.14.0)
**Branch**: `worktree-brainstorm-agent-fs-space`

## Research Question

Answer the 11 fact-shaped Open Questions from `thoughts/taras/brainstorms/2026-09-29-agent-fs-space-in-dashboard.md` (Synthesis section), for "Comb": a native dashboard view of the swarm's agent-fs drive where humans comment on agent-written files, @-mention people, and send batches of comments to the lead as one task.

## Summary

agent-fs already carries almost everything Comb reads: structured diffs by version number, comments with a version pointer (`fileVersion`), unresolved-root listing, per-user notifications, and `/auth/me` with email. Production agent-fs (`agent-fs-taras.fly.dev`) runs **0.14.0** and answers cross-origin preflights with `access-control-allow-origin: *`, so a browser holding an `af_` key can call it directly today. Three gaps are factual, not design: `comment-list` filters by **exact path only** (no folder prefix), the member-listing endpoints are **admin-only** (a normal editor cannot list drive members), and there is **no mention field or targeted notification** (every comment notifies every drive member). Media in `live/` loads through **signed URLs** into `<img>`/`<video>`/`<iframe>` tags, which do not need bucket CORS. The `/raw` route always sends `Content-Disposition: attachment` and has no Range support.

The anchoring logic in `live/` splits cleanly: `live/src/lib/comment-anchor.ts` is pure TS with zero imports and can be copied as is. The hook around it depends on `live/`'s auth context, client, and stores. The highlight painting depends on react-markdown's hast positions (`data-line-*`). The dashboard renders markdown with **Streamdown 2.5** (no plugin props passed, fenced code inside Monaco) and has **no** use of `CSS.highlights`, `getSelection`, or DOM Ranges anywhere.

On the swarm side, the realtime stack cannot serve the dashboard as is. The browser client is hard-wired to `/p/<pageId>` pages, socket auth reads only an `Authorization` header (or a same-origin page cookie), and the only signed token (`page_session`) is explicitly scope-locked to pages. Every room persists a KV snapshot row with no expiry, and the 100-rooms-per-namespace cap counts persisted rows, so one room per file in one namespace stops at 100 files. **Channels** are the persistence-free alternative (in-process pub/sub, no cap beyond 100 per socket, no built-in presence). Task creation already routes to the lead when `agentId` is omitted (`POST /api/tasks`), with `source: "ui"` and `requestedByUserId`. There is no task idempotency key; KV is the documented dedup store. `user_favorites.itemType` is still CHECK-constrained to `page|workflow|schedule`. The notification bell today renders **static, code-defined** notifications, not source-driven ones. Worker images pin agent-fs **0.14.0** (CLI + baked skill, which already documents `agent-fs comment ...`).

## Answers to the brainstorm's Open Questions

| # | Question | Answer (details below) |
|---|---|---|
| 1 | Does `comment-list` filter by path prefix? | **No.** Exact `path` match, or omit `path` to list the whole drive (unresolved roots by default, `limit` has no max, offset paging, no total). Folder roll-up needs a drive-wide list filtered client-side, per-file calls, or a new agent-fs param. |
| 2 | `diff` output and version identity | Structured `{changes: [{type, content, oldLine?, newLine?}]}` from `structuredPatch`, keyed by **version numbers** (`v1`, `v2` both required). Comments store the `file_versions` row id but `comment-list` returns `fileVersion` (the number). Needs a versioning backend (Tigris/S3 are full-tier). `live/`'s `DiffViewer.tsx` is 65 lines, recomputes line numbers client-side. |
| 3 | Portability of `use-comment-anchors.ts` | `lib/comment-anchor.ts` is **import-free** and portable. The hook needs `useAuth` (client/org/drive), `useFileStat`, react-query, and a small store. Highlight painting (`dom-text-space.ts`) depends on react-markdown hast positions stamped as `data-line-*`. |
| 4 | Streamdown in `apps/ui`, anchors on its DOM | Streamdown `^2.5.0` is the markdown renderer (`MarkdownView`, no plugin props). Fenced code renders in Monaco (not plain text nodes). No `CSS.highlights` / `getSelection` / Range code exists in `apps/ui`. Whether Streamdown accepts rehype plugins or exposes source positions was **not verified**. |
| 5 | Rooms: namespace, eviction, presence-only | Namespace = free-form string (non-page identities choose it). Every room persists a `_room/<name>` KV row with no expiry. 100-room cap per namespace **counts persisted rows**. Idle eviction after 5 min frees memory only. No presence-only rooms. **Channels** are ephemeral pub/sub with no persistence and no room count, but no built-in presence. |
| 6 | Smallest realtime auth path for the dashboard | Today: `Authorization` header or a same-origin `page_session` cookie with `?pageId=`. No query-token auth anywhere, no SSE. `page_session` (HMAC, 1 h TTL, dedicated secret) is the only signed-token precedent, and its file header says "scope-locked to pages, do NOT reuse". The browser client only runs on `/p/<id>`. |
| 7 | Dashboard user → agent-fs user mapping | `/api/whoami` returns the swarm user (optional `email`, `emailAliases`) only for `aswt_` tokens; operator-key sessions use an untrusted localStorage picker. `users.email` is nullable. agent-fs `/auth/me` returns `{userId, email, displayName, ...}`. Email is the only shared field. |
| 8 | Loading PDF/image/video bytes in the browser | `/raw` works via Bearer `fetch` → blob → object URL (CORS `*`, verified on prod), always `attachment` disposition, no Range, whole object buffered. `live/` uses **signed URLs** (`disposition: inline` for PDF) in media tags, which need no bucket CORS. No bucket CORS is configured anywhere; JS `fetch` of a presigned URL would need it. |
| 9 | `user_favorites` path type | CHECK is `('page','workflow','schedule')` after migration 116 (table rebuilt there with `favoriteScope`). `itemId` is free text. A new type needs another table rebuild + `FavoriteItemTypeSchema` (`src/types.ts:1022`). Favorites are not in the sidebar today. |
| 10 | Prompt template + lead routing for a review batch | `POST /api/tasks` without `agentId` auto-assigns the lead (`src/http/tasks.ts:852-862`). Templates register via `registerTemplate` (`src/prompts/registry.ts:33`); `jira.issue.commented` is the closest "comment → task" precedent. No template carries agent-fs paths today. No task idempotency key; KV is the documented dedup store. |
| 11 | agent-fs prod version + release path | Prod = **0.14.0** (live `/health`). Release: `scripts/release.sh` → merge → `auto-release.yml` publishes npm + `ghcr.io/desplega-ai/agent-fs`. Fly deploy is manual (`scripts/fly-deploy.ts`). Swarm workers pin `AGENT_FS_VERSION=0.14.0` (`Dockerfile.worker:224`). `live/` deploys on Vercel. |

## Detailed Findings

## Findings: agent-fs bytes, CORS, auth, deploy (agent-fs repo, v0.14.0)

### Raw bytes route
- `GET /orgs/:org/drives/:drive/files/<path>/raw` (`packages/server/src/routes/files.ts:25-91`) reads the whole object (`s3.getObject`, :46) and returns it buffered (:78). No streaming, no Range support, no `?disposition` param.
- Headers (:58-76): `Content-Type` (+ charset), `Content-Length`, `Content-Disposition: attachment; filename*=...` (always), `Cache-Control: private, max-age=60`, and when a version row exists `ETag`, `X-Agent-FS-Version`, `X-Agent-FS-Content-Hash`, `Last-Modified`.
- Behind `authMiddleware` (`packages/server/src/app.ts:56`): needs `Authorization: Bearer`.
- CORS (`app.ts:27-33`): default origins `["*"]` → Hono `cors()` before auth. No `exposeHeaders` anywhere, so browser JS cannot read `ETag` or `X-Agent-FS-*` on cross-origin responses.
- `live/src/api/client.ts:300-307` (`fetchRaw`) does Bearer fetch → blob → object URL. Works cross-origin under the wildcard.

### signed-url op
- `packages/core/src/ops/signed-url.ts`: params `path`, `expiresIn` (default 86400, :42), `disposition` `inline|attachment` (default attachment, :79). Content type from extension (`detectMimeType`, :77).
- S3/Tigris (`packages/core/src/s3/client.ts:242-257`): presigned `GetObjectCommand` with `ResponseContentType` + `ResponseContentDisposition`. Returns `{url, path, expiresIn, expiresAt, kind: "presigned"}` pointing at the bucket origin.
- Local adapter (`packages/core/src/storage/local-adapter.ts:99`, `presignedUrls: false`): falls back to an in-app link `{kind: "app", expiresIn: 0}` built from `appUrl` (`signed-url.ts:61-75`). Throws `UnsupportedOperation` (HTTP 422) when `appUrl` is unset.
- No bucket CORS config in code, docs, `fly.toml`, compose, or scripts. `thoughts/taras/plans/2026-03-19-signed-urls-fe-and-mime-types.md:527-535` notes the bucket needs CORS for JS `fetch`, not for `<img>`/`<iframe>`/`<video>` tags.

### How live/ loads media
- `ImageViewer`, `PdfViewer`, `VideoViewer` use `useSignedUrl` (`live/src/hooks/use-signed-url.ts:10,26`). PDF asks `inline` (`PdfViewer.tsx:13`) → `<iframe src>`. Video → `<video src controls>` (`VideoViewer.tsx:11,31`). Media never goes through blob URLs.
- Text: `live/src/lib/file-content-cache.ts:160-167` mints a signed URL, then `fetch` + `res.text()` + etag (comment at :165 says storage must expose `ETag` via CORS).
- Downloads: signed URL first, `fetchRaw` fallback (`live/src/lib/download.ts:41`).

### Auth endpoints
- `POST /auth/register` (`packages/server/src/routes/auth.ts:17-45`): 200 `{apiKey, userId, orgId}`. Duplicate email → **409** `CONFLICT` "User with this email already exists" (:37-42).
- `POST /auth/reset-key` (:75-95): authenticated, rotates the caller's own key, returns `{apiKey}`.
- `GET /auth/me` (:51-73): `{userId, email, displayName, defaultOrgId, defaultDriveId}`.
- `POST /orgs/:orgId/members/invite` (`packages/server/src/routes/orgs.ts:104-111`): caller must be org admin (`requireOrgAdmin`). `inviteToOrg` (`packages/core/src/identity/orgs.ts:217-265`) throws a plain `Error` when the email has no user (:228-230). Not an `AgentFSError`, so the server answers **500** `INTERNAL_ERROR` (`packages/server/src/middleware/error.ts:21-36`). No pending invites. On success it upserts org membership and default-drive membership with the same role.

### Deploy and release
- `fly.toml`: app `agent-fs-taras`, region `ams`, root `Dockerfile`, env `AGENT_FS_HOME=/data`, `AGENT_FS_CLOUD=true`, volume at `/data`, port 7433. Storage provider via `AGENT_FS_STORAGE_PROVIDER` + `AWS_*`/`S3_*` secrets (Tigris) (`packages/core/src/config.ts:229,251-262`, `DEPLOYMENT.md:105,166-171`).
- Dockerfile runs `bun run packages/cli/dist/cli.js server` (:43).
- Release (`RELEASING.md`): `./scripts/release.sh X.Y.Z` syncs versions + pushes. Merge to `main` → `auto-release.yml` tags and dispatches npm + Docker publish (`ghcr.io/desplega-ai/agent-fs`). Published npm: `@desplega.ai/agent-fs`, `-just-bash`, fuse helpers. `core`/`server`/`mcp` unpublished. `live/` deploys via Vercel. Fly deploys are manual (`scripts/fly-deploy.ts`).
- **Live check (2026-09-29):** `https://agent-fs-taras.fly.dev/health` → `{"ok":true,"version":"0.14.0","maxUploadBytes":52428800,"features":["share-links"]}`. Preflight from a foreign origin → `204`, `access-control-allow-origin: *`, `allow-headers: authorization,content-type`.
- CORS origins configurable only in `${AGENT_FS_HOME}/config.json` → `server.cors.origins` (`config.ts:85-87,137-139,157-159`). No env var.

## Findings: agent-fs comments, diff, anchors, mentions surface, members

### comment-list / comment-notification-list
- `comment-list` params (`core/ops/types.ts:284-291`, zod `ops/index.ts:302-309`): `path?, parentId?, resolved?, orgId?, limit?, offset?`. Where-clause (`core/ops/comment.ts:292-315`): org + drive + not deleted; **`path` is an exact match** (`eq`, :298-300). **No prefix filter.** Omitting `path` lists the whole drive.
- Default (no `parentId`, `resolved` falsy): unresolved roots. `resolved: true` → all roots (resolved + unresolved) (:304-311).
- Pagination: `limit` default 50 (no max), `offset` 0, `createdAt DESC`, no total, no cursor (:317-324). Replies nested per root, ascending (:329-351).
- `CommentEntry` (`types.ts:293-313`): `id, parentId, path, lineStart/End, quotedContent, quote{exact,prefix,suffix}, body, author, authorDisplayName, resolved, resolvedBy, resolvedAt, fileVersionId, fileVersion, replyCount, createdAt, updatedAt`.
- `comment-notification-list` (`core/ops/comment-notification.ts:29-105`): `unreadOnly?, limit (1..100)?, offset?`. Scoped to `target = ctx.userId` and the ctx drive. Returns `{notifications, unreadCount}`, entries `{id, commentId, parentId, path, body, actor, createdAt, read}` (`actor` = user id, no display name). `comment-notification-read` sets `status='ack'` (:107-174).

### diff + log + versions
- `diff` (`core/ops/diff.ts:8-106`): params `path, v1: number, v2: number` (version **numbers**, `types.ts:100-104`). Output `{changes: [{type: add|remove|context, content, lineNumber?, oldLine?, newLine?}]}` (`types.ts:222-234`), from `structuredPatch` of the `diff` lib (:61-66). Needs a versioning S3 backend + `s3VersionId` on both records. Fallback without versioning: one remove + one add from `diffSummary` JSON (:93-105). No size cap, no binary check.
- `log` (`core/ops/log.ts:5-35`): `{versions: [{version, author, createdAt, operation, message?, diffSummary?, size?}]}`, `version DESC`, limit 50.
- `comments.fileVersionId` = `file_versions` **row id** (`schema.ts:108,151`), set at add time to the latest row (`comment.ts:225-236`). `comment-list` resolves it to `fileVersion` (the number) via `addFileVersions` (:169-181). Clients diff `fileVersion → currentVersion`.
- `live/src/components/viewers/DiffViewer.tsx:1-65`: props `{changes, className}`. Recomputes line numbers client-side (:10-32). Flex row per change, green/red backgrounds. Fed by `useDiff` (`live/src/hooks/use-diff.ts:5-11`).

### Comment anchoring (live/)
- `live/src/hooks/use-comment-anchors.ts:1-18` imports: react, `@tanstack/react-query` (`useQueries`), `@/contexts/auth` (`useAuth` → client, orgId, driveId), `@/hooks/use-file-stat` (current version), `@/lib/comment-anchor`, `@/stores/comment-anchors`, types. No router. Diff call via `client.callOp(orgId, "diff", ...)` (:77), `staleTime: Infinity`, `retry: false` (:73-82).
- **`live/src/lib/comment-anchor.ts` has no imports** (pure TS): `resolveAnchor`, `resolveAnchorInView`, `anchorNeedsDiff`, `commentAnchorInput`, `diffHasLineNumbers`, `sourceTextSpace`.
- `resolveAnchor` (:375-457) order: exact quote (strict or loose normalisation, prefix/suffix disambiguation) → line range (remapped through the diff when stale) → quote only / partial (32 chars each end) → `lost`. Status `anchored | moved | lost`. The hook fetches a diff only for stale comments that need it.
- Highlights (`live/src/components/viewers/MarkdownViewer.tsx`): react-markdown + remark-gfm + rehype-highlight + custom `rehypeSourceLines` (`live/src/lib/dom-text-space.ts:164-178`) that stamps `data-line-start/end` on block elements from hast positions. `buildDomTextSpace(root)` (dom-text-space.ts:41+) maps DOM text nodes to offsets (`toRange`, `pointToOffset`, `lineRangeToOffsets`). Painting (:342-386) builds DOM Ranges and registers `CSS.highlights` (`comment-anchor`, `-moved`, `-active`). Fallback: `comment-indicator` class on blocks (:185).
- New comment target: `targetFromDom` (:729-738) + `captureQuote` (32 chars context) + `data-line-*`. Selection via `window.getSelection()` (`handleMouseUp`, :488-511).
- react-markdown-coupled parts: `data-line-*` (needs hast `position`), the BLOCK_TAGS list, component overrides, commentable selectors. `comment-anchor.ts` itself is renderer-independent.

### Surface for @-mentions
- `comment-add` params (`types.ts:261-269`; zod `ops/index.ts:279-340`): `path?, body, parentId?, lineStart?, lineEnd?, quotedContent?, quote?`. `body` is a plain string, no mention parsing. `comment-update` `{id, body}` (`comment.ts:411-443`) emits no event. Validation (:185-286): replies only to roots, quote caps (exact 4000, prefix/suffix 64).
- `comments` table (`core/db/schema.ts:132-162`): no mention columns.
- Notifications: `emitCommentNotifications` (`comment.ts:52-89`), called from `commentAdd` (:268-273), inserts one `comment_notification` event per drive member except the author, `metadata {path, parentId}`. A separate `comment_created` event via `emitEvent` (:25-50). `events` table (`schema.ts:165-194`): `id, org_id, type, resource_type, resource_id, actor, target, status (created|ack|deleted), metadata, created_at`, index `idx_events_notification_inbox(org_id, type, target, status, created_at)`.
- MCP (`packages/mcp/src/tools.ts:7-63`): every core op becomes a tool automatically (`comment-add`, `comment-list`, ...). New op params flow through without MCP code.
- CLI (`packages/cli/src/commands/comment.ts`): `add, reply, list, get, update, delete, resolve, reopen, notifications, read`, each `client.callOp(...)`.
- `live/src/components/comments/AddComment.tsx`: plain `<Textarea>` + Send, Cmd/Ctrl+Enter (:78-82), `useAddComment().mutate(...)` (:44-46). No mention picker.
- agent-fs DB migrations: no migrations dir. `runMigrations` (`core/db/migrate.ts:13-68`) runs on every open: `PRAGMA table_info` → `ALTER TABLE ADD COLUMN` (precedent: comments `quote_*` columns, :40-49), `CREATE ... IF NOT EXISTS`. Tests in `db/__tests__/comment-quote-migration.test.ts`.

### Members
- `GET /orgs/:orgId/members` (`packages/server/src/routes/orgs.ts:115-121`, org admin only) and `GET /orgs/:orgId/drives/:driveId/members` (:174-182, drive admin or org admin): `{members: [{userId, email, role}]}`. No display name. **Both are admin-gated.**
- `users.displayName` exists and is used by `addAuthorNames` (`comment.ts:157-165`).

## Findings: swarm realtime, WebSocket auth, dashboard identity

### Rooms and channels
- Namespace (`src/realtime/auth.ts:35-68`): page identity → forced `task:page:<id>`. Otherwise explicit `msg.namespace` (regex `^[a-zA-Z0-9._:/-]{1,512}$`, `rooms.ts:87`) → source task `contextKey` → `task:agent:<agentId>`. Room name `^[a-zA-Z0-9_-]{1,64}$` (`rooms.ts:90`), default `"default"`.
- Caps (`rooms.ts:16-21`): 100 rooms/namespace (counted over persisted `_room/%` KV rows + live rooms, create fails at the cap, :331-341), 1000 active rooms (:294-296), 2 MB envelope. Per socket: 100 rooms, 100 channels; 1000 sockets total (`transport.ts:124,238,258`).
- Persistence: KV `kv_entries`, key `_room/<name>`, envelope `{format: "swarm-room-v1", schemaVersion, generation, snapshot}`, no expiry (`rooms.ts:497-506`). Flush debounced 1000 ms. A new room flushes an empty snapshot immediately (`rooms.ts:265,275`). **No presence-only rooms.** Awareness itself is memory-only.
- Idle eviction (`rooms.ts:535-552`): 5 min idle + no awareness + no subscribers + flushed. Evicts from memory; the KV row stays.
- **Channels** (`transport.ts:111-113,235-253`): topic `channel:[namespace,name]`, ops `subscribe/unsubscribe/publish`, in-process bus only (`bus.ts:5-33`). No Yjs doc, no awareness, **no KV write, no room count**, 64 KiB payload. No built-in presence (subscribers publish their own).
- Authorization (`auth.ts:86-130`, called per message at `transport.ts:224-234`): reads allowed for any resolvable namespace. Writes (`update/change/reset/presence/publish`): a non-operator user under RBAC needs `grantsAll` or `kv.write.any`; `task:page:*` writable by that page or agents; `task:agent:*` by operator (no agentId) or `kv.write.any`; **any other namespace is allowed**.
- Session re-check every 15 s (`transport.ts:196-202,391`).

### Browser client
- `src/realtime/browser.ts:71-123` requires `location.pathname` to match `/p/<id>`, else throws "Realtime rooms require a Swarm page". Connects `/@swarm/realtime?pageId=<id>` with cookies. API: `room(name, {schemaVersion})` (ydoc, state, change, apply, reset, presence.set/peers, on, close) and `channel(name)` (publish, on, close). Reconnect after 1 s with resync (:108-133).
- Bundled by `scripts/build-realtime-browser.ts` → `src/realtime/browser.generated.txt`, served unauthenticated at `GET /@swarm/realtime.js` (`src/http/realtime.ts:5-27`). Not an npm package. **`apps/ui/src` has zero realtime references.**

### WebSocket auth
- `resolveHttpRequestAuth` (`src/http/auth.ts:26-68`) reads only `Authorization: Bearer` (API key → operator, optionally page-scoped via `X-Page-Session` + `X-Page-Id`; `aswt_` → user; `aseph_` → agent session).
- Existing signed token: `page_session` (`src/utils/page-session.ts`): `base64url(JSON).base64url(HMAC-SHA256)` (:130-138), payload `{pageId, exp, uid?, name?}` (:42-50), secret from `PAGE_SESSION_SECRET` / file / generated 0600 file, never the API key (:78-124), TTL 3600 s (:274), constant-time verify (:149-224). File header: "scope-locked to pages, do NOT reuse". Issued by `POST /api/pages/{id}/launch` (`src/http/pages.ts:780-823`) as an `HttpOnly` cookie (`SameSite=None; Secure` outside dev).
- The cookie socket path (`transport.ts:67-90`) needs `?pageId=`, `Origin` host == `Host`, and a matching cookie pageId.
- Query-param auth: only `/p/:id?key=` (page password, `pages-public.ts:419-434`). **No `?token=` API auth. No SSE/EventSource anywhere.** The dashboard polls (react-query).

### Dashboard identity
- `apps/ui/src/contexts/current-user-context.tsx`: `aswt_` user token → `/api/whoami`, locked (:96-98). `VITE_USER_ID` → locked (:99-100). Otherwise localStorage picker `swarm:v1:${apiUrl}:current-user` (:86), cross-tab synced. `?email=` hint auto-binds (:159-186).
- `/api/whoami` (`src/http/users.ts:540-551`): `{kind: "user", user}` or `{kind: "operator", user: null}`. `UserSchema` (`src/types.ts:909-928`) has optional `email`, `emailAliases`, no avatar.
- Bearer from `getConfig().apiKey` (`apps/ui/src/api/client.ts:266-275`). Connections in localStorage `agent-swarm-connections` `{connections: [{id, name, apiUrl, apiKey}], activeId}` (`apps/ui/src/lib/config.ts:5,64-102`); deployment connection overrides (:31,234-242).
- **swarmId is not implemented.** `/health` returns `{status, version}` only (`src/http/core.ts:403-416`). The existing namespacing helper is `deriveStorageKey(apiUrl, key)` → `swarm:v1:${apiUrl}:${key}` (`apps/ui/src/hooks/use-dismissible-card-key.ts:9-13`).
- `users.email` is nullable (`031_user_registry.sql:5`, kept by `067_users_first_class.sql:152-185`), partial unique index when not null.

## Findings: dashboard building blocks (apps/ui)

### Markdown + code
- Streamdown `^2.5.0` (`apps/ui/package.json:52`). `MarkdownView` (`src/components/shared/markdown-view.tsx:156-179`) renders `<Streamdown components={STREAMDOWN_COMPONENTS}>` with no plugin props. Overrides (:115-148): fenced code → `MonacoCodeBlock`, inline code chip, `pre` unwrapped, links `target="_blank"` (:140).
- Only syntax highlighter: Monaco (`@monaco-editor/react ^4.7.0`, `package.json:23`). `MonacoCodeBlock` (:50-110) is read-only with `lineNumbers: "off"`. Line numbers on only in debug/templates pages. No shiki/prism/highlight.js.
- **No `CSS.highlights`, `new Highlight(`, `getSelection`, `createRange`, or `selectionchange` anywhere in `apps/ui/src`.** Fenced code inside markdown renders in Monaco (its own DOM, not plain text nodes).

### Previews + byte loading
- All inline in `src/components/shared/task-attachments-section.tsx` (exports only `TaskPromptAttachments` :693 and `TaskAttachmentsSection` :811). `getPreviewKind` (:138-170) → `image|video|pdf|text|null`. `PreviewMedia` (:740-808) renders `<img>`, `<video controls>`, `<iframe src=objectUrl>`. Blob fetch via `fetchTaskAttachmentBlob` (`src/api/fs.ts:120-129`), object URL created (:279) and revoked on change (:298-302). Text: 512 KB cap, `scrubPreviewText` (3 regexes incl. `af_` prefix, :193-198), 20,000-char slice, `<pre>`.
- No CSV parser/viewer. AG Grid (`ag-grid-community`/`ag-grid-react ^35.1.0`) via `src/components/shared/data-grid`, mandated for data lists by `apps/ui/CLAUDE.md`.
- No path-based agent-fs read in `src/api/fs.ts`. Every call is task-scoped.

### Notification bell + inbox
- `notification-bell.tsx`: Popover + Bell + unread Badge (:57-80), hidden without `currentUser.userId` (:30). Data: `useInboxState({userId, itemType: "notification"})` (:25). On open, marks each definition read (:37-54).
- `notification-panel.tsx` maps **static, code-defined** `NOTIFICATION_DEFINITIONS` (`lib/notifications/definitions.ts:20-26`, `{key, title, body}`), custom cards via `CARD_COMPONENTS` (:10-15). The bell is not source-driven today.
- Inbox buckets (`api/hooks/use-inbox.ts`): `useBlockingInbox` (:83), `useBrokenInbox` (:158), `useToReadInbox` (:220), `useToStartInbox` (:274), each joined with `buildHiddenSet` (:40-55). The bell does not use them.
- `InboxItemType` (`apps/ui/src/api/types.ts:608-614`) mirrors server `InboxItemTypeSchema` (`src/types.ts:987-994`). **`057_inbox_item_state.sql` has no CHECK on `itemType`** (zod-enforced, :4), `UNIQUE(userId, itemType, itemId)` (:23). Migration 156 adds `readAt`. Routes `src/http/inbox-state.ts`.
- Default polling: `refetchInterval: 10000`, `staleTime: 2000` (`app/providers.tsx:14-15`).

### Navigation, status, favorites
- Router: lazy default-export pages, flat children under `RootLayout` (`app/router.tsx:9-66,116-153`).
- Sidebar (`components/layout/app-sidebar.tsx`): `navGroups` WORK / SWARM / RESOURCES (:106-156), `NavItem {title, path, icon, gate?: {minVersion}, beta?, children?, minRole?}` (:62-84). Conditional display is **version gates only** (`useFeatureGate`, :361-367). No capability-based item today.
- `/status` via `useStatus` (`api/hooks/use-status.ts:17-31`, 30 s, paused when hidden). Consumers use `useStatusContext()` (`app/status-context.tsx:45`). `StatusAgentFs {configured, base_url, provider_id, capabilities}` typed (`api/types.ts:2720-2725`), unread. `useFsCapabilities` (`api/fs.ts:135-141`) unused.
- Favorites: `useFavorites` / `useFavoriteToggle` (`api/hooks/use-favorites.ts`), `FavoriteItemType = page | workflow | schedule` (:5-9). `favorite-button.tsx`, `favorite-column.tsx`. **Favorites do not appear in the sidebar.**

### Mention/autocomplete primitives
- `components/ui/command.tsx` (shadcn over `cmdk ^1.1.1`), `components/ui/popover.tsx` (Radix), `components/shared/combobox.tsx` (trigger-button select), `components/shared/command-menu.tsx` (Cmd+K). **No caret-anchored mention picker exists.**

### localStorage conventions
- `swarm:v1:${apiUrl}:<key>` via `deriveStorageKey` (used by dismissible cards, local toggles, current user). Ad hoc keys elsewhere (`agent-swarm-task-rail-collapsed-v2`, `agent-swarm:sidebar-group:<id>`, theme keys, `agent-swarm-query-cache-v1`).

## Findings: swarm server (favorites, tasks, prompts, idempotency, links)

### user_favorites
- `105_user_favorites.sql:8`: `itemType ... CHECK (itemType IN ('page','workflow','schedule'))`, `itemId TEXT NOT NULL`.
- `116_favorite_principal_scope.sql` rebuilds the table: same CHECK (:12), adds `favoriteScope TEXT NOT NULL`, nullable `userId`, `UNIQUE (favoriteScope, itemType, itemId)` (:18), backfill `'user:'||userId` (:26).
- zod `FavoriteItemTypeSchema = z.enum(["page","workflow","schedule"])` (`src/types.ts:1022`), `UserFavoriteSchema` (:1025-1036). `itemId` is `z.string().min(1)` (`src/http/favorites.ts:40`).
- Routes (`src/http/favorites.ts`): `GET /api/favorites` (:9-29, `itemType?`, `itemIds?`), `PUT /api/favorites` (:31-55, `{itemType, itemId, favorite}`, `rbac: favorite.write.own`). Owner via `resolveHttpFavoriteOwner` (`src/http/favorite-owner.ts`, 401 without a principal).

### Task creation and lead routing
- `POST /api/tasks` (`src/http/tasks.ts:244`, handler :827-953), UI `ApiClient.createTask` (`apps/ui/src/api/client.ts:468-507`).
- Body (:250-288): `task`, `agentId?`, `routingReason?`, `routingNote?`, `taskType?`, `tags?`, `priority?`, `dependsOn?`, `offeredTo?`, `dir?`, `parentTaskId?`, `key?` (asset namespace, not idempotency), `source?`, `outputSchema?`, `contextKey?`, `requestedByUserId?`, `model?`, `modelTier?`, `effort?`, `draft?`. **No `metadata` field.** `routingReason` required when `agentId`/`offeredTo` set (:280-288).
- **No `agentId` → the handler assigns the lead** via `getLeadAgent()` (:852-862), "mirrors Slack so UI composer tasks are not left unassigned". Auto `routingReason` (`continuity` or `skill`), `routingSource: engine_default` (:888-899).
- `source` defaults to `"api"` (:909). UI callers send `"ui"` (`session-composer.tsx:86`, `first-message-card.tsx:67`). `AgentTaskSourceSchema` (`src/types.ts:334-347`); the SQL CHECK on `agent_tasks.source` was dropped in `056_drop_agent_tasks_source_check.sql` (zod is the only gate).
- `requestedByUserId`: trusted server identity first; body value honored when `TRUST_BODY_REQUESTED_BY_USER_ID != "false"` and the user exists (:844-850).
- Lead routing guidance: `system.agent.lead` template (`src/prompts/session-templates.ts:86-104`), `get-swarm` roster, `send-task` with `routingReason` + `routingNote`.

### Prompt templates
- `registerTemplate({eventType, header, defaultBody, variables, category})` (`src/prompts/registry.ts:33`), in-memory map at module load; DB `prompt_templates` rows override bodies; header is not overridable (:16-18). `{{var}}` interpolation.
- Resolve: `resolveTemplate` (`resolver.ts:158`, sync DB) / `resolveTemplateAsync` (:178, workers via HTTP).
- Integration templates live next to their integration: `src/{github,jira,slack,linear,agentmail,gitlab,heartbeat,commands,tools}/templates.ts`. Closest precedent: `jira.issue.commented` (`src/jira/templates.ts:39-65`), header `[Jira {{issue_key}}] {{issue_summary}}`, body lines `Source:`, `URL:`, `Comment author:`, `Comment:`. Also `slack.message.thread_context` (`src/slack/templates.ts:56-69`).
- agent-fs in prompts: `system.agent.outputs` / `.no_agent_fs` (`session-templates.ts:194-224`), chosen in `base-prompt.ts:183-192`. No template carries agent-fs paths or comment ids.

### How agents use agent-fs
- Worker env: `AGENT_FS_API_URL`, `AGENT_FS_API_KEY`, `AGENT_FS_DEFAULT_ORG_ID`, `AGENT_FS_DEFAULT_DRIVE_ID`, `AGENT_FS_SHARED_ORG_ID`, provisioned by the runner through the API (`src/commands/runner.ts:910-1009`, `src/be/seed/agent-fs-provision.ts`).
- The `agent-fs` skill is baked from upstream at `v${AGENT_FS_VERSION}` (`Dockerfile.worker:221-226`, `AGENT_FS_VERSION=0.14.0` at :224). The upstream skill (`agent-fs/skills/agent-fs/SKILL.md:199-211`) documents `comment add | reply | list | get | update | delete | resolve | notifications | read`, including `--quote` anchoring.
- Seeded `templates/skills/artifacts/content.md:36-126` covers `agent-fs write/stat/signed-url` and `store-progress` attachments, not comments.

### Idempotency
- Slack: in-memory 5-min `event_id` cache (`src/slack/event-dedup.ts:24-81`). GitHub: in-memory 60 s map (`src/github/handlers.ts:29-31,128`). Jira: DB-persisted `tracker_sync.lastDeliveryId` (`src/be/db-queries/tracker.ts:235-265`, `src/jira/webhook.ts:50-67`).
- `POST /api/tasks` has **no** idempotency key. `idempotencyKey` exists on `script_runs`, `workflow_run_steps`, and `/api/scripts` runs.
- KV (`src/http/kv.ts`): `GET/PUT/DELETE /api/kv/{key}` and `/api/kv/_/{namespace}/{key}`, `POST .../incr` (:573), `expiresInSec` TTL (:56,684). The `kv-storage` skill names KV for "dedup and idempotency keys".

### Status + link builders
- `GET /status` (`src/http/status.ts:688-692`): `agent_fs: {configured: !!AGENT_FS_API_URL, base_url, provider_id, capabilities}` (`StatusAgentFsSchema` :122-127, provider via `getAgentFsStatusProvider` :698-714).
- `buildAgentFsLiveUrl({path?, orgId?, driveId?})` (`src/utils/constants.ts:118-140`): row ids win, else `AGENT_FS_DEFAULT_ORG_ID`/`_DRIVE_ID`; `${getAgentFsLiveUrl()}/file/~/<org>/<drive>/<path>`; `AGENT_FS_LIVE_URL` or `https://live.agent-fs.dev` (:79,85). Called only from `task-attachment-links.ts:33`.
- `taskAttachmentDisplayUrl(attachment)` (`src/utils/task-attachment-links.ts:26-46`), call sites: `src/commands/context-preamble.ts:108`, `src/slack/render-v2.ts:1103`, `src/be/task-citations.ts:59`, `src/slack/blocks.ts:215`, `src/tasks/worker-follow-up.ts:163`.
- UI copy: `apps/ui/src/components/shared/task-attachment-link.tsx:8` (used by `task-attachments-section.tsx:49`).
- `getAppUrl()` (`constants.ts:42-44`): first `APP_URL`, else first `DASHBOARD_URL`, else `https://app.agent-swarm.dev` (:15).

## Code References

| File | Line | Description |
|------|------|-------------|
| `agent-fs/packages/core/src/ops/comment.ts` | 292-315 | `comment-list` where-clause, exact path match |
| `agent-fs/packages/core/src/ops/comment.ts` | 52-89 | Broadcast `comment_notification` to all drive members |
| `agent-fs/packages/core/src/ops/diff.ts` | 8-106 | Structured diff by version numbers |
| `agent-fs/packages/core/src/db/migrate.ts` | 13-68 | Additive `ALTER TABLE` migrations (precedent for a mentions column) |
| `agent-fs/packages/server/src/routes/files.ts` | 25-91 | `/raw`: forced attachment, no Range, buffered |
| `agent-fs/packages/core/src/ops/signed-url.ts` | 42-93 | Signed URL, `inline` disposition supported |
| `agent-fs/packages/server/src/routes/orgs.ts` | 104-121, 174-182 | Invite + member listings (admin-gated) |
| `agent-fs/packages/core/src/identity/orgs.ts` | 217-230 | `inviteToOrg` throws for unknown email (→ 500) |
| `agent-fs/live/src/lib/comment-anchor.ts` | 375-505 | Import-free anchor resolution |
| `agent-fs/live/src/lib/dom-text-space.ts` | 41, 164-178 | DOM text space + `rehypeSourceLines` |
| `agent-fs/live/src/components/viewers/MarkdownViewer.tsx` | 342-386, 488-511 | `CSS.highlights` painting, selection capture |
| `agent-fs/live/src/components/viewers/DiffViewer.tsx` | 1-65 | Diff rendering |
| `src/realtime/rooms.ts` | 16-21, 265-275, 331-341, 535-552 | Caps, immediate snapshot flush, namespace cap, idle sweep |
| `src/realtime/transport.ts` | 67-108, 111-113, 235-253 | Socket auth, channel topics, channel ops |
| `src/realtime/auth.ts` | 35-68, 86-130 | Namespace resolution + write authorization |
| `src/realtime/browser.ts` | 71-123 | Client hard-wired to `/p/<id>` |
| `src/utils/page-session.ts` | 42-50, 130-138, 274 | Only signed short-lived token (page-scoped) |
| `src/http/auth.ts` | 13-68 | Bearer-only request auth |
| `src/http/tasks.ts` | 250-288, 852-862 | Task body schema, lead auto-assignment |
| `src/prompts/registry.ts` | 33 | `registerTemplate` |
| `src/jira/templates.ts` | 39-65 | Comment → task template precedent |
| `src/be/migrations/116_favorite_principal_scope.sql` | 12, 18 | Current favorites CHECK + unique key |
| `src/utils/constants.ts` | 79-140 | Live URL builder + defaults |
| `apps/ui/src/components/shared/markdown-view.tsx` | 50-179 | Streamdown wrapper, Monaco code blocks |
| `apps/ui/src/components/shared/task-attachments-section.tsx` | 138-302, 740-808 | Previews + blob lifecycle |
| `apps/ui/src/components/notifications/notification-bell.tsx` | 19-80 | Bell backed by static definitions |
| `apps/ui/src/components/layout/app-sidebar.tsx` | 62-156, 361-367 | Nav items + version-only gating |
| `apps/ui/src/contexts/current-user-context.tsx` | 86-203 | Identity modes |
| `apps/ui/src/hooks/use-dismissible-card-key.ts` | 9-13 | `swarm:v1:${apiUrl}:<key>` namespacing |
| `Dockerfile.worker` | 221-226 | agent-fs CLI + skill pinned at 0.14.0 |

## Open Questions (resolved in the follow-up, 2026-09-30)

- **Tigris bucket CORS on prod: open to all origins.** Live check with a real presigned URL (from `agent-fs signed-url` against `agent-fs-taras.fly.dev`, host `fly.storage.tigris.dev`): preflight and GET both return `Access-Control-Allow-Origin: *`, `Allow-Methods: *`, `Allow-Headers: *`, **`Access-Control-Expose-Headers: *`**, and a readable `Etag`. So a browser can `fetch()` signed URLs and read `ETag`, the same way `live/src/lib/file-content-cache.ts:160-167` does.
- **`/auth/register` exemption:** `PUBLIC_PATHS = ["/auth/register", "/health"]` (`agent-fs/packages/server/src/middleware/auth.ts:6`), matched by `path === p || path.startsWith(p)` (:12). Register is public.
- **Room rows on prod:** 5 `_room/*` KV rows across 4 namespaces, all `task:page:*` (read-only `sqlite3` query on the prod DB, 2026-09-30). The only cleanup path is `deletePage` (`src/be/db.ts:8526-8536`), which deletes `kv_entries` for `task:page:<id>` and publishes `room:namespace-deleted` (handled at `src/http/index.ts:432-435` → `removeNamespaceRooms`). **Rooms in any non-page namespace are never deleted.**
- **Room and channel names:** both use `nameSchema = /^[a-zA-Z0-9_-]{1,64}$/` (`src/realtime/transport.ts:24,38`). A file path cannot be a room or channel name as is. It needs a hash or an id.
- **Streamdown internals (installed `node_modules/streamdown` v2.5.0, minified `dist/chunk-BO2N2NFS.js` + `dist/index.d.ts`):**
  - `rehypePlugins` / `remarkPlugins` props exist (`index.d.ts:65-77,410`) and **replace** the defaults. Defaults: rehype `raw` → `sanitize` (custom schema) → `harden`; remark `gfm` → `codeMeta`. `defaultRehypePlugins` and `defaultRemarkPlugins` are exported (`index.d.ts:492`) so a custom list can spread them.
  - No react-markdown. Streamdown has its own unified pipeline (`remark-parse` → remark plugins → `remark-rehype` with `allowDangerousHtml` → rehype plugins → `toJsxRuntime` with `passNode: true`). A custom rehype plugin sees `node.position.start/end.line`. Position survival through `rehype-sanitize`/`rehype-raw` was not checked, so place a line-stamping plugin first.
  - **Default `mode` is `"streaming"`**: `parseMarkdownIntoBlocks` (marked `Lexer`) splits the doc and each block renders separately, so hast lines are **block-relative**. `mode="static"` renders the whole doc once with document-absolute lines. `parseMarkdownIntoBlocksFn` can also override the splitter. `MarkdownView` (`markdown-view.tsx:178`) passes no `mode`, so it runs in streaming mode today.
  - Chrome that adds text nodes or buttons: `code-block-header` (language label), `code-block-actions`, table-wrapper toolbar buttons, `image-fallback`, portaled `link-safety-modal` / `table-fullscreen`. Nearly every element carries `data-streamdown="<name>"`, so a text walker can skip by attribute. The `controls` prop can disable code/table buttons.
  - Other props: `components` merged over built-ins, `parseIncompleteMarkdown` (default `true`), `controls`, `BlockComponent`, `animated`, `isAnimating`.
  - Consequence for anchoring (fact, not design): `mode="static"` + `parseIncompleteMarkdown={false}` + a `rehypePlugins` list of `[lineStamp, ...defaultRehypePlugins]` reproduces what `live/`'s `rehypeSourceLines` relies on. Note the repo's `code` override renders fenced code in Monaco, whose DOM is not plain text nodes.

## Appendix

- **Architecture notes**: agent-fs is the byte + comment + version authority; the swarm API owns tasks, users, favorites, inbox state, and realtime. The dashboard polls via react-query (10 s default, 30 s for `/status`); there is no SSE. Realtime is WebSocket-only at `/@swarm/realtime` on the API origin, with an in-process bus (single API replica).
- **Historical context (from thoughts/)**:
  - `thoughts/taras/brainstorms/2026-09-29-agent-fs-space-in-dashboard.md`: the Comb brainstorm (decisions this research serves).
  - `thoughts/taras/brainstorms/2026-06-25-agent-fs-first-class.md`: provider abstraction + `/api/fs/*` (PR #850).
  - `thoughts/taras/brainstorms/2026-08-04-realtime-collab-primitive.md` + `thoughts/taras/qa/2026-09-09-realtime-rooms-1090.md`: rooms design and QA.
  - `thoughts/taras/learnings/2026-05-08-per-swarm-localstorage-namespacing.md`: proposes `swarmId`; not implemented (the code namespaces by API URL).
  - agent-fs `thoughts/taras/plans/2026-03-19-signed-urls-fe-and-mime-types.md:527-535`: bucket CORS needed for JS fetch, not for media tags.
- **Related research**:
  - `thoughts/taras/research/2026-06-25-agent-fs-first-class.md`: agent-fs integration deep dive.
  - `thoughts/taras/research/2026-08-04-realtime-collab-primitive-open-questions.md`: realtime open questions.
