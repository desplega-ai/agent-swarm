import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { getApiKey } from "@/utils/api-key";
import { getMcpBaseUrl } from "@/utils/constants";
import type { RequestInfo } from "./utils";

export const SCRIPT_TRANSPORT_ERROR =
  "script_* tools require HTTP MCP transport — agent identity is not available over stdio in this build. Switch to MCP_BASE_URL=http://... or invoke the HTTP API directly.";

export const scriptNameSchema = z.string().min(1).max(200);
export const scriptScopeSchema = z.enum(["agent", "global"]);
export const scriptFsModeSchema = z.enum(["none", "workspace-rw"]);

export const scriptToolOutputSchema = z.object({
  success: z.boolean(),
  status: z.number(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

export type ScriptToolStructuredContent = z.infer<typeof scriptToolOutputSchema>;

function apiBaseUrl(): string {
  return getMcpBaseUrl();
}

function toolError(message: string, status = 400): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {
      success: false,
      status,
      error: message,
    } satisfies ScriptToolStructuredContent,
  };
}

export async function proxyScriptsApi(args: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  requestInfo: RequestInfo;
  successMessage: (data: unknown) => string;
}): Promise<CallToolResult> {
  if (!args.requestInfo.agentId) return toolError(SCRIPT_TRANSPORT_ERROR);

  const apiKey = getApiKey();
  const res = await fetch(`${apiBaseUrl()}${args.path}`, {
    method: args.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Agent-ID": args.requestInfo.agentId,
      "Content-Type": "application/json",
    },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  });

  const text = await res.text();
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  const error =
    typeof data === "object" && data !== null && "error" in data
      ? String((data as { error: unknown }).error)
      : undefined;

  if (!res.ok) {
    return toolError(error ?? `Scripts API request failed with ${res.status}`, res.status);
  }

  return {
    content: [{ type: "text", text: args.successMessage(data) }],
    structuredContent: {
      success: true,
      status: res.status,
      data,
    } satisfies ScriptToolStructuredContent,
  };
}
