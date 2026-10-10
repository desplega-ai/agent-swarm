// Loading a drive file as text (`useAgentFsText` runs this as its query).
// Relative imports only, so `bun:test` can import it from the repo root.

import type { AgentFsClient } from "../agent-fs/client";
import type { StatResult } from "../agent-fs/types";
import type { DrivePath } from "./paths";

/** Text files above this size are not loaded (the viewer offers a download). */
export const COMB_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** `text` is null when the file is larger than `COMB_TEXT_MAX_BYTES` (`tooLarge`). */
export type AgentFsText = { tooLarge: false; text: string } | { tooLarge: true; text: null };

/**
 * The file as text, read through the raw bytes route (`cat` stops at 200
 * lines). A file above `COMB_TEXT_MAX_BYTES` is not fetched.
 */
export async function readDriveText(
  client: Pick<AgentFsClient, "fetchRaw">,
  target: DrivePath,
  stat: Pick<StatResult, "size">,
  signal?: AbortSignal,
): Promise<AgentFsText> {
  if (stat.size > COMB_TEXT_MAX_BYTES) return { tooLarge: true, text: null };
  const blob = await client.fetchRaw(target.orgId, target.driveId, target.path, { signal });
  return { tooLarge: false, text: await blob.text() };
}
