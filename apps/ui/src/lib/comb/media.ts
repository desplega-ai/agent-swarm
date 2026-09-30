// Media loading rules for the Comb image, video, and PDF viewers. Pure, with
// relative imports only, so the root test runner covers them.

import { AgentFsError } from "../agent-fs/client";
import type { SignedUrlResult } from "../agent-fs/types";
import { fileExtension } from "./file-kinds";

export type MediaKind = "image" | "video" | "pdf";

/**
 * Blob mode reads the whole file into memory, so a larger file shows the
 * "too large" fallback. Presigned URLs stream and have no cap.
 */
export const COMB_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** A presigned URL this close to its expiry counts as missing, so a new one is minted. */
export const MEDIA_URL_EXPIRY_MARGIN_MS = 5 * 60_000;

/** Where media loads from: a presigned storage URL, or the Bearer `/raw` bytes (`blob`). */
export type MediaSource = { kind: "presigned"; url: string; expiresAt: number } | { kind: "blob" };

/**
 * The media source for a `signed-url` op outcome. A presigned URL is used,
 * and its expiry counts from `mintedAt` on this clock. A 422 (the backend has
 * no presigned URLs) or an `app` link falls back to blob mode. Any other
 * error is the result, so the viewer shows it.
 */
export function mediaSourceFrom(
  outcome: { result: SignedUrlResult } | { error: unknown },
  mintedAt: number,
): MediaSource | { kind: "error"; error: unknown } {
  if ("error" in outcome) {
    return outcome.error instanceof AgentFsError && outcome.error.status === 422
      ? { kind: "blob" }
      : { kind: "error", error: outcome.error };
  }
  const { result } = outcome;
  if (result.kind !== "presigned") return { kind: "blob" };
  return { kind: "presigned", url: result.url, expiresAt: mintedAt + result.expiresIn * 1000 };
}

/** The presigned URL when it is outside the expiry margin at `at`, else null. */
export function freshPresignedUrl(source: MediaSource | undefined, at: number): string | null {
  return source?.kind === "presigned" && source.expiresAt - MEDIA_URL_EXPIRY_MARGIN_MS > at
    ? source.url
    : null;
}

/**
 * How to build a blob-mode media URL. Security rule: an object URL has the
 * dashboard's origin, the dashboard has no CSP, and localStorage holds the
 * swarm and agent-fs keys. So a file opened top-level from that URL must never
 * render as a document (HTML, or SVG with scripts), whatever its stored type:
 * - Raster images and video get `application/octet-stream`. `<img>` and
 *   `<video>` still sniff and decode the bytes, and a top-level open downloads.
 * - A PDF gets `application/pdf`, so its frame shows the PDF viewer only.
 * - SVG needs its own type to render in `<img>`, so it gets a `data:` URL.
 *   A `data:` URL opened top-level has an opaque origin.
 */
export function blobUrlPlan(
  kind: MediaKind,
  path: string,
  contentType?: string,
): { as: "object-url" | "data-url"; type: string } {
  if (kind === "pdf") return { as: "object-url", type: "application/pdf" };
  const svg =
    fileExtension(path) === "svg" || contentType?.toLowerCase().startsWith("image/svg+xml");
  if (kind === "image" && svg) return { as: "data-url", type: "image/svg+xml" };
  return { as: "object-url", type: "application/octet-stream" };
}
