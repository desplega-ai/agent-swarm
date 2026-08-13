import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createAriaHqRepository } from "../ariahq/repository";
import { getDb } from "../be/db";
import { scrubSecrets } from "../utils/secret-scrubber";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "./utils";

const normalizedRecordSchema = z.object({
  sourceRef: z.string().min(1),
  sourceRevision: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  effectiveAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin"), sourceId: z.string().uuid() }),
  z.object({
    action: z.literal("commit"),
    sourceId: z.string().uuid(),
    runId: z.string().uuid(),
    nextCursor: z.string().optional(),
    records: z.array(normalizedRecordSchema).max(10_000),
  }),
  z.object({
    action: z.literal("fail"),
    sourceId: z.string().uuid(),
    runId: z.string().uuid(),
    errorMessage: z.string().min(1).max(20_000),
  }),
]);

export const registerAriaKnowledgeSourceTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "ariahq-knowledge-source",
    {
      title: "Run an AriaHQ knowledge source sync",
      description:
        "Begin, atomically commit, or fail a knowledge-source sync. Calls are restricted to the agent bound to that source.",
      annotations: { destructiveHint: false },
      inputSchema,
      outputSchema: swarmToolOutputSchema({
        source: z.looseObject({}).optional(),
        run: z.looseObject({}).optional(),
      }),
    },
    async (args, requestInfo) => {
      if (!requestInfo.agentId) return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      const repository = createAriaHqRepository(getDb());

      try {
        if (args.action === "begin") {
          const source = repository.getKnowledgeSourceForRunner(args.sourceId, requestInfo.agentId);
          if (!source) return toolErr("Knowledge source is unavailable to this agent.");
          const run = repository.beginKnowledgeSync(args.sourceId, requestInfo.agentId);
          return toolOk(`Started knowledge sync for ${source.name}.`, { data: { source, run } });
        }

        if (args.action === "commit") {
          const run = repository.completeKnowledgeSync({
            sourceId: args.sourceId,
            runId: args.runId,
            agentId: requestInfo.agentId,
            records: args.records,
            ...(args.nextCursor === undefined ? {} : { nextCursor: args.nextCursor }),
          });
          return toolOk(
            `Completed knowledge sync: ${run.recordsCreated} created, ${run.recordsReused} reused.`,
            { data: { run } },
          );
        }

        const run = repository.failKnowledgeSync(
          args.sourceId,
          args.runId,
          requestInfo.agentId,
          scrubSecrets(args.errorMessage),
        );
        return toolOk("Recorded knowledge sync failure.", { data: { run } });
      } catch (error) {
        const message = scrubSecrets(error instanceof Error ? error.message : String(error));
        return toolErr(`Knowledge source sync operation failed: ${message}`);
      }
    },
  );
};
