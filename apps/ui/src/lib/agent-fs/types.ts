// agent-fs wire types that Comb uses.
//
// `packages/core/src/ops/types.ts` and `live/src/api/types.ts`, copied from
// agent-fs e713bc6 (main after v0.14.0), plus the mention fields of v0.15.0.
// `Date` fields become ISO strings, because these values arrive as JSON. Keep
// names in sync with the source so more of `live/` can be ported later.

/** `GET /health` (public). `features` is absent on older servers. */
export interface HealthResponse {
  ok: boolean;
  version: string;
  maxUploadBytes?: number;
  features?: string[];
}

/** `POST /auth/register` (public). */
export interface RegisterResponse {
  apiKey: string;
  userId: string;
  orgId: string;
}

/** `GET /auth/me`. */
export interface MeResponse {
  displayName?: string | null;
  userId: string;
  email: string;
  defaultOrgId: string | null;
  defaultDriveId: string | null;
}

export interface LsEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  author?: string;
  modifiedAt?: string;
}

export interface LsResult {
  entries: LsEntry[];
}

export interface StatResult {
  path: string;
  size: number;
  contentType?: string;
  author: string;
  currentVersion?: number;
  createdAt: string;
  modifiedAt: string;
  isDeleted: boolean;
  embeddingStatus?: string;
  /**
   * Storage ETag of the current bytes. Opaque: compare for equality only.
   * Absent when the storage backend does not report one.
   */
  etag?: string;
}

/** One member of a drive (`drive-members` op, agent-fs `/health` feature `drive-members`). */
export interface DriveMember {
  userId: string;
  email: string;
  displayName: string | null;
}

export interface DriveMembersResult {
  members: DriveMember[];
}

/** One version in the `log` op answer (newest first). */
export interface VersionEntry {
  version: number;
  author: string;
  createdAt: string;
  operation: string;
  message?: string;
  diffSummary?: string;
  size?: number;
}

export interface LogResult {
  versions: VersionEntry[];
}

export interface DiffChange {
  type: "add" | "remove" | "context";
  content: string;
  lineNumber?: number;
  /** 1-based line in v1 (set on "remove" and "context" when content was diffed). */
  oldLine?: number;
  /** 1-based line in v2 (set on "add" and "context" when content was diffed). */
  newLine?: number;
}

export interface DiffResult {
  changes: DiffChange[];
}

export interface RevertParams {
  path: string;
  version: number;
  /** Expected current head version (the one being replaced). */
  expectedVersion?: number;
}

export interface RevertResult {
  version: number;
  revertedTo: number;
}

/**
 * Text-quote anchor: the exact selected text plus up to 32 chars of context on
 * each side, used to re-find the selection after the file changes.
 */
export interface CommentQuote {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/** A mentioned drive member (agent-fs feature `comment-mentions`). */
export interface CommentMention {
  userId: string;
  displayName: string | null;
  email: string;
}

export interface CommentEntry {
  id: string;
  parentId?: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  quotedContent?: string;
  quote?: CommentQuote;
  body: string;
  author: string;
  authorDisplayName?: string;
  /** Absent on agent-fs before v0.15.0. */
  mentions?: CommentMention[];
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  fileVersionId?: number;
  /** Version number of fileVersionId (the head version when the comment was made). */
  fileVersion?: number;
  replyCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommentListEntry extends CommentEntry {
  replies: CommentEntry[];
}

export interface CommentListResult {
  comments: CommentListEntry[];
}

/** `comment-add`. A root needs `path`. A reply needs `parentId` (it takes the root's path). */
export interface CommentAddParams {
  path?: string;
  body: string;
  parentId?: string;
  /** Drive-member user ids or emails (agent-fs feature `comment-mentions`). */
  mentions?: string[];
  lineStart?: number;
  lineEnd?: number;
  quotedContent?: string;
  quote?: CommentQuote;
}

export interface CommentAddResult {
  id: string;
  path: string;
  body: string;
  parentId?: string;
  lineStart?: number;
  lineEnd?: number;
  quote?: CommentQuote;
  author: string;
  authorDisplayName?: string;
  createdAt: string;
}

export interface CommentResolveResult {
  id: string;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
}

/** `comment-update` (author only). `mentions` replaces the stored mentions; omit it to keep them. */
export interface CommentUpdateParams {
  id: string;
  body: string;
  mentions?: string[];
}

export interface CommentUpdateResult {
  id: string;
  body: string;
  updatedAt: string;
}

/** `comment-delete` (author only). A root takes its replies with it. */
export interface CommentDeleteResult {
  deleted: boolean;
}

export interface CommentNotificationEntry {
  /** Notification event ID. */
  id: string;
  /** agent-fs v0.15.0+. `comment-notification-list` returns only "comment" unless `kinds` says otherwise. */
  kind?: "comment" | "mention";
  commentId: string;
  parentId?: string;
  path: string;
  body: string;
  actor: string;
  createdAt: string;
  read: boolean;
}

export interface CommentNotificationListResult {
  notifications: CommentNotificationEntry[];
  unreadCount: number;
}

export interface CommentNotificationReadResult {
  markedRead: number;
}

/** One file version in the core `recent` op's answer. Newest first. */
export interface RecentEntry {
  /** Drive path, with or without the leading "/". */
  path: string;
  version: number;
  /** agent-fs user id of the writer. */
  author: string;
  createdAt: string;
  operation: "write" | "edit" | "append" | "delete" | "revert";
  message?: string;
  size?: number;
}

/** Result of the core `recent` op: the drive's newest file versions. */
export interface RecentResult {
  entries: RecentEntry[];
}

/** Result of the core `find` op (fuzzy file names, agent-fs 0.18.5+). Best first. */
export interface FindResult {
  matches: Array<{ path: string; size: number; modifiedAt?: string; score: number }>;
  /** Matching files before the `limit` cap. */
  total: number;
}

/** Result of the core `fts` op. `snippet` marks matches with `<b>` and `</b>`. */
export interface FtsResult {
  matches: Array<{ path: string; snippet: string; rank: number }>;
  hint?: string;
  tookMs?: number;
}

/** Result of the core `search` op (vector and keyword results merged by rank). */
export interface SearchResult {
  results: Array<{
    path: string;
    score: number;
    snippet: string;
    /** PDF chunks only. */
    page?: number;
    kind?: string;
    author?: string;
    modifiedAt?: string;
  }>;
  hint?: string;
  tookMs?: number;
}

/** Result of a write (`PUT .../raw`). */
export interface WriteResult {
  version: number;
  path: string;
  size: number;
  contentHash?: string;
  /** True when the bytes matched the head version, so no version was added. */
  deduped?: boolean;
}

/** Result of the core `share-create` op (feature `share-links`). */
export interface ShareCreateResult {
  id: string;
  /** `file` for a file. `site` for a folder (`/site/<token>/`). Absent on older servers. */
  kind?: "file" | "site";
  /** Absolute when the server knows its public address, else the same as `sharePath`. */
  url: string;
  /** Host-relative link: `/share/<token>` for a file, `/site/<token>/` for a folder. */
  sharePath: string;
  path: string;
  expiresIn: number;
  /** ISO time. */
  expiresAt: string;
  /** `null` = unlimited views. */
  maxViews: number | null;
}

/** Mirrors the `disposition` param of the core `signed-url` op. */
export type SignedUrlDisposition = "inline" | "attachment";

/** Result of the core `signed-url` op. */
export interface SignedUrlResult {
  url: string;
  path: string;
  expiresIn: number;
  /** ISO expiry for a `presigned` URL. Empty for a non-expiring `app` link. */
  expiresAt: string;
  /**
   * `"presigned"`: a public, time-limited download URL.
   * `"app"`: an authenticated in-app link, for backends without presigned URLs.
   */
  kind: "presigned" | "app";
}

/** One star (`favorite-list`, feature `favorites`). Per agent-fs user and drive. */
export interface AgentFsFavorite {
  /** "/docs/a.md" or "/docs" (a folder has no trailing "/"). */
  path: string;
  kind: "file" | "directory";
  createdAt: string;
}

export interface FavoriteListResult {
  favorites: AgentFsFavorite[];
}
