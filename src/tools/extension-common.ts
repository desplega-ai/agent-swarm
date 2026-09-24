import * as z from "zod";
import { proxySwarmApi } from "./script-common";
import { type RequestInfo, type SwarmToolResult, swarmToolOutputSchema, toolErr } from "./utils";

export const EXTENSION_TRANSPORT_ERROR =
  "extension_* tools require HTTP MCP transport because agent identity is unavailable over stdio. Use MCP_BASE_URL=http://... or invoke the HTTP API directly.";

const extensionListItemSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  version: z.number().optional(),
  activeVersion: z.number().optional(),
  createdByAgentId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  status: z.string().optional(),
  priority: z.number().optional(),
  consecutiveFailures: z.number().optional(),
});

export const extensionToolOutputSchema = swarmToolOutputSchema({
  id: z.string().optional(),
  name: z.string().optional(),
  version: z.number().optional(),
  activeVersion: z.number().optional(),
  createdByAgentId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  status: z.string().optional(),
  priority: z.number().optional(),
  consecutiveFailures: z.number().optional(),
  contentDeduped: z.boolean().optional(),
  deleted: z.boolean().optional(),
  extensions: z.array(extensionListItemSchema).optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function coerceExtensionSummary(entry: unknown) {
  const extension = isRecord(entry) ? entry : {};
  return {
    id: typeof extension.id === "string" ? extension.id : undefined,
    createdByAgentId:
      typeof extension.createdByAgentId === "string" ? extension.createdByAgentId : null,
    name: typeof extension.name === "string" ? extension.name : undefined,
    version: typeof extension.version === "number" ? extension.version : undefined,
    activeVersion:
      typeof extension.activeVersion === "number" ? extension.activeVersion : undefined,
    enabled: typeof extension.enabled === "boolean" ? extension.enabled : undefined,
    status: typeof extension.status === "string" ? extension.status : undefined,
    priority: typeof extension.priority === "number" ? extension.priority : undefined,
    consecutiveFailures:
      typeof extension.consecutiveFailures === "number" ? extension.consecutiveFailures : undefined,
  };
}

function errorMessage(data: unknown, status: number): string {
  if (isRecord(data) && typeof data.error === "string" && data.error) {
    // Coded errors (inline_install_disabled, extension_template_not_found) carry the explanation in `message`.
    return typeof data.message === "string" && data.message
      ? `${data.error}: ${data.message}`
      : data.error;
  }
  return `Extensions API request failed with ${status}`;
}

function renderDiagnostics(data: unknown): string | undefined {
  if (!isRecord(data) || !Array.isArray(data.diagnostics)) return undefined;
  const diagnostics = data.diagnostics.map(String).filter(Boolean);
  return diagnostics.length > 0 ? diagnostics.join("\n") : undefined;
}

export async function proxyExtensionsApi<T>(args: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  requestInfo: RequestInfo;
  success: (data: unknown) => SwarmToolResult<T & Record<string, unknown>>;
}): Promise<SwarmToolResult<T & Record<string, unknown>>> {
  return proxySwarmApi({
    ...args,
    transportError: EXTENSION_TRANSPORT_ERROR,
    respond: (data, response) => {
      if (!response.ok) {
        const diagnostics = renderDiagnostics(data);
        if (response.status === 400 && diagnostics) {
          return toolErr("Extension rejected by typecheck.", { details: diagnostics });
        }
        return toolErr(errorMessage(data, response.status), { details: diagnostics });
      }
      return args.success(data);
    },
  });
}
