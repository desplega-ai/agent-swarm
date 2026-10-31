import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "@/server";
import { CORE_TOOLS } from "@/tools/tool-config";
import type { RequestCompositionToolLoading } from "@/types";
import type { McpSessionOptions } from "./mcp";

/** One entry of an MCP `tools/list` response, as the harness receives it. */
export type ListedTool = {
  name: string;
  description?: string;
  inputSchema: unknown;
  _meta?: Record<string, unknown>;
};

export type ToolSchemaEstimate = {
  /** Chars the harness sends up front: loaded schemas plus deferred tool names. */
  chars: number;
  loadedCount: number;
  deferredCount: number;
};

const isAlwaysLoad = (tool: ListedTool): boolean => tool._meta?.["anthropic/alwaysLoad"] === true;

/**
 * Size a tool list the way each harness sends it. A loaded tool costs its
 * name, description and JSON schema. A deferred tool costs only its name in
 * the harness's deferred-tool listing; its schema enters history when loaded.
 */
export function measureToolSchemas(
  tools: readonly ListedTool[],
  loading: RequestCompositionToolLoading,
): ToolSchemaEstimate {
  if (loading === "none") return { chars: 0, loadedCount: 0, deferredCount: 0 };
  const isLoaded = (tool: ListedTool): boolean => {
    if (loading === "all") return true;
    if (loading === "core") return CORE_TOOLS.has(tool.name) || isAlwaysLoad(tool);
    return isAlwaysLoad(tool);
  };
  let chars = 0;
  let loadedCount = 0;
  for (const tool of tools) {
    if (isLoaded(tool)) {
      loadedCount++;
      chars += JSON.stringify({
        name: tool.name,
        description: tool.description ?? "",
        input_schema: tool.inputSchema,
      }).length;
    } else {
      chars += tool.name.length + 1;
    }
  }
  return { chars, loadedCount, deferredCount: tools.length - loadedCount };
}

/** List the tools an MCP session built from `opts` would expose. */
async function listSessionTools(opts: McpSessionOptions): Promise<ListedTool[]> {
  const server = await createServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "request-composition-estimate", version: "1" });
  try {
    await client.connect(clientTransport);
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

// Schemas are static per build; the surface depends only on these inputs.
const MAX_MEMO_ENTRIES = 32;
const toolListMemo = new Map<string, Promise<ListedTool[]>>();

/** Clear memoised tool lists (tests). */
export function resetToolSchemaMemo(): void {
  toolListMemo.clear();
}

/** The `tools/list` payload for one session surface, memoised per input set. */
export function listSessionToolsMemo(opts: McpSessionOptions): Promise<ListedTool[]> {
  const key = JSON.stringify({
    opts,
    capabilities: process.env.CAPABILITIES ?? null,
    chatSdk: process.env.CHAT_SDK_ENABLED ?? null,
  });
  const cached = toolListMemo.get(key);
  if (cached) return cached;
  if (toolListMemo.size >= MAX_MEMO_ENTRIES) toolListMemo.clear();
  const pending = listSessionTools(opts);
  toolListMemo.set(key, pending);
  pending.catch(() => toolListMemo.delete(key));
  return pending;
}
