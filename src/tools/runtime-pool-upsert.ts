import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RuntimePoolUpdateSchema } from "../types";
import { proxyRuntimePoolsApi, runtimePoolToolOutputSchema } from "./runtime-pool-common";
import { createToolRegistrar, toolErr } from "./utils";

export const registerRuntimePoolUpsertTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "runtime-pool-upsert",
    {
      title: "Runtime Pool Upsert",
      description:
        "Create a runtime pool, or update a pool by id. Creation requires name, kind, and one controller placement. Operator or user callers only: agents, including the lead, get a permission error. A lead can place agents into existing pools with runtime-pool-create-agent or runtime-pool-bind-agent.",
      annotations: { openWorldHint: false },
      inputSchema: RuntimePoolUpdateSchema.extend({ id: z.string().min(1).optional() }),
      outputSchema: runtimePoolToolOutputSchema,
    },
    async (args, requestInfo) => {
      if (!args.id && (!args.name || !args.kind || !args.placements))
        return toolErr("Pool creation requires name, kind, and one controller placement.");
      const { id: _, ...body } = args;
      return proxyRuntimePoolsApi({
        method: args.id ? "PATCH" : "POST",
        path: args.id ? `/api/runtime-pools/${encodeURIComponent(args.id)}` : "/api/runtime-pools",
        body: body,
        requestInfo,
        message: "Runtime pool saved.",
      });
    },
  );
};
