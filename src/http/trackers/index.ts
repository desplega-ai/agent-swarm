import type { IncomingMessage, ServerResponse } from "node:http";
import { handleLinearTracker } from "./linear";

export async function handleTrackers(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  return await handleLinearTracker(req, res, pathSegments);
}
