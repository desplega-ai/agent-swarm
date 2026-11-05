/**
 * Upload an image to agent-fs and return the `MediaIcon` that points at it.
 * Shared by the app icon editor and (later) agent avatars: the caller picks
 * the drive and a path prefix such as `/apps/<appId>/icon`.
 */

import type { MediaIcon } from "@/api/types";
import type { AgentFsClient } from "@/lib/agent-fs/client";

/** Image types the dashboard renders as an icon, with the extension each one gets. */
export const MEDIA_ICON_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

/** 1 MB: an icon renders at tile size, so a bigger file only slows the page. */
export const MEDIA_ICON_MAX_BYTES = 1024 * 1024;

/** `accept` value for the file input. */
export const MEDIA_ICON_ACCEPT = Object.keys(MEDIA_ICON_TYPES).join(",");

/** Same cap as the server's `HttpsImageUrlSchema`. */
const MAX_ICON_URL_LENGTH = 2048;

/**
 * A pasted icon link, checked like the server checks it (https, no
 * credentials, at most 2048 characters), so a bad link fails before Save.
 */
export function parseMediaIconUrl(
  text: string,
): { ok: true; icon: Extract<MediaIcon, { type: "url" }> } | { ok: false; error: string } {
  const value = text.trim();
  if (!value) return { ok: false, error: "Paste an https image URL." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "Enter a valid image URL." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Use an https URL." };
  if (url.username || url.password) {
    return { ok: false, error: "Remove the username and password from the URL." };
  }
  if (value.length > MAX_ICON_URL_LENGTH) return { ok: false, error: "The URL is too long." };
  return { ok: true, icon: { type: "url", url: value } };
}

/** A readable reason the file cannot be an icon, or null when it can. */
export function mediaIconFileError(file: { type: string; size: number }): string | null {
  if (!Object.hasOwn(MEDIA_ICON_TYPES, file.type)) {
    return "Use a PNG, JPEG, WebP, GIF, or SVG image.";
  }
  if (file.size > MEDIA_ICON_MAX_BYTES) return "The image must be 1 MB or smaller.";
  return null;
}

/** `<prefix>-<now>.<ext>`, absolute. Throws on a type `mediaIconFileError` rejects. */
export function mediaIconPath(filePrefix: string, mimeType: string, now: number): string {
  const ext = Object.hasOwn(MEDIA_ICON_TYPES, mimeType) ? MEDIA_ICON_TYPES[mimeType] : undefined;
  if (!ext) throw new Error("Use a PNG, JPEG, WebP, GIF, or SVG image.");
  const prefix = `/${filePrefix.replace(/^\/+/, "")}`;
  return `${prefix}-${now}.${ext}`;
}

export interface MediaIconDrive {
  orgId: string;
  driveId: string;
}

/**
 * Validate `file`, write it create-only to `<filePrefix>-<epochMs>.<ext>`, and
 * return `{type:"agent-fs", path}`. The IDs are left out of the icon: it lives
 * on the swarm drive, which readers resolve from `/status`.
 */
export async function uploadMediaIcon(
  client: Pick<AgentFsClient, "putRaw">,
  drive: MediaIconDrive,
  filePrefix: string,
  file: File,
  now: () => number = Date.now,
): Promise<Extract<MediaIcon, { type: "agent-fs" }>> {
  const error = mediaIconFileError(file);
  if (error) throw new Error(error);
  const path = mediaIconPath(filePrefix, file.type, now());
  await client.putRaw(drive.orgId, drive.driveId, path, file, {
    ifNoneMatch: true,
    message: "Upload icon",
  });
  return { type: "agent-fs", path };
}
