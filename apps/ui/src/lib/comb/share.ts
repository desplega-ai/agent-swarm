// Comb share links: the agent-fs `share-create` op makes a public, read-only
// link to one file. Pure, with relative imports only, so the root test runner
// covers it. Rules follow agent-fs `live/src/lib/share-link.ts`.

import type { ShareCreateResult } from "../agent-fs/types";
import { isHtmlPath } from "./html-view";

/** The `/health` feature of servers that can make share links. */
export const SHARE_LINKS_FEATURE = "share-links";

/** The expiry choices. agent-fs allows up to 7 days. */
export const SHARE_EXPIRY_CHOICES = [
  { label: "1 hour", seconds: 3600 },
  { label: "24 hours", seconds: 86_400 },
  { label: "3 days", seconds: 259_200 },
  { label: "7 days", seconds: 604_800 },
] as const;

export type ShareExpirySeconds = (typeof SHARE_EXPIRY_CHOICES)[number]["seconds"];

/** agent-fs's own default, so the preselected choice matches a link made elsewhere. */
export const DEFAULT_SHARE_EXPIRY_SECONDS: ShareExpirySeconds = 86_400;

/**
 * The link to copy. It is built from the agent-fs URL this browser already
 * uses (`AGENT_FS_PUBLIC_URL`), not from the server's idea of its own address,
 * so it stays right behind a proxy. Without `sharePath` the server's `url` is
 * used.
 */
export function shareLinkUrl(
  endpoint: string,
  result: Pick<ShareCreateResult, "url" | "sharePath">,
): string {
  return result.sharePath ? `${endpoint.replace(/\/+$/, "")}${result.sharePath}` : result.url;
}

/** "1 hour", "24 hours", "3 days", "45 minutes". */
export function describeExpiry(seconds: number): string {
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  if (seconds < 48 * 3600) {
    const hours = Math.round(seconds / 3600);
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${Math.round(seconds / 86_400)} days`;
}

/**
 * What the dialog says the link shares. An HTML page is served alone, so the
 * files next to it (images, scripts, styles) do not load from the link.
 */
export function shareDescription(path: string): string {
  return isHtmlPath(path)
    ? "Anyone with the link can view this page. Only this file is shared, so files next to it (images, styles, scripts) do not load."
    : "Anyone with the link can view and download this file. It does not need an agent-fs account.";
}
