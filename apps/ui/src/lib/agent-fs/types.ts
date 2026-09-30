// agent-fs wire types that Comb uses.
//
// Copied from agent-fs `packages/core/src/ops/types.ts` and
// `live/src/api/types.ts` at commit e713bc6 (v0.14.0). `Date` fields become
// ISO strings, because these values arrive as JSON. Keep names in sync with
// the source so more of `live/` can be ported later.

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

/**
 * Text-quote anchor: the exact selected text plus up to 32 chars of context on
 * each side, used to re-find the selection after the file changes.
 */
export interface CommentQuote {
  exact: string;
  prefix?: string;
  suffix?: string;
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

export interface CommentNotificationEntry {
  /** Notification event ID. */
  id: string;
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
