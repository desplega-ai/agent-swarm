import { getPublicMcpBaseUrl } from "../utils/constants";
import type { RuntimeTargetConfig } from "./types";

export function resolveWorkerApiUrl(target: RuntimeTargetConfig): string {
  return (
    target.WORKER_API_URL ??
    target.RUNTIME_WORKER_API_URL ??
    target.PUBLIC_MCP_BASE_URL ??
    getPublicMcpBaseUrl()
  );
}
