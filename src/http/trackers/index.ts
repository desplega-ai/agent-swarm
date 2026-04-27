import type { IncomingMessage, ServerResponse } from "node:http";
import { handleJiraTracker } from "./jira";
import { handleLinearTracker } from "./linear";

export async function handleTrackers(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  // Provider-specific dispatch based on the third path segment
  // (e.g. "api", "trackers", "<provider>", ...).
  if (pathSegments[0] === "api" && pathSegments[1] === "trackers") {
    if (pathSegments[2] === "jira") {
      return await handleJiraTracker(req, res, pathSegments);
    }
    if (pathSegments[2] === "linear") {
      return await handleLinearTracker(req, res, pathSegments);
    }
  }
  // Fallback: try Linear (preserves existing behavior for any path that
  // somehow falls through without an explicit provider segment).
  return await handleLinearTracker(req, res, pathSegments);
}
