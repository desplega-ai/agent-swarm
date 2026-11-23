import { sql } from "../db";
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { cancelTask, createPinnedTask } from "./knowledge-helpers";
import {
  callToolErr,
  callToolOk,
  expectRunOk,
  registerAgent,
  runScript,
  structured,
  toolText,
  upsertScript,
  withMcp,
} from "./script-helpers";

const SOURCE = `import type { ScriptContext } from "swarm-sdk";
export default async function (args: {
  canonicalId: string; aliasId: string; matchingId: string; taskId: string;
  referencesSource: string;
}, ctx: ScriptContext) {
  const common = { taskId: args.taskId, note: "script rating", referencesSource: args.referencesSource };
  const canonical = await ctx.swarm.memory_rate({ id: args.canonicalId, useful: true, ...common });
  const alias = await ctx.swarm.memory_rate({ memoryId: args.aliasId, useful: false, ...common });
  const matching = await ctx.swarm.memory_rate({ id: args.matchingId, memoryId: args.matchingId, useful: true, ...common });
  let conflict = "";
  try {
    await ctx.swarm.memory_rate({ id: args.canonicalId, memoryId: args.aliasId, useful: true, ...common });
  } catch (error) {
    conflict = error instanceof Error ? error.message : String(error);
  }
  let missing = "";
  try {
    await ctx.swarm.memory_rate({ useful: true, ...common });
  } catch (error) {
    missing = error instanceof Error ? error.message : String(error);
  }
  return { canonical, alias, matching, conflict, missing };
}`;

/** A saved, typechecked script rates retrieved memories through both identifier names. */
export const scriptMemoryRate: Scenario = {
  name: "script-memory-rate",
  order: 421,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "memory-rate");
    const memoryIds = await withMcp(ctx, agentId, async (connection) => {
      const ids: string[] = [];
      for (const label of ["canonical", "alias", "matching"]) {
        const stored = structured(
          await callToolOk(connection, "memory-store", {
            content: `Script rating ${label} memory ${ctx.nonce}`,
            name: `Script rating ${label} ${ctx.nonce}`,
            scope: "agent",
          }),
        );
        const memoryIds = stored.memoryIds;
        expect(Array.isArray(memoryIds) && typeof memoryIds[0] === "string", "memory-store id");
        ids.push(String(memoryIds[0]));
      }
      return ids;
    });
    const [canonicalId, aliasId, matchingId] = memoryIds as [string, string, string];
    const conflictMessage = "id and memoryId must identify the same memory; supply only one.";
    const missingMessage = "Supply id (or its alias memoryId) from memory-search.";
    await withMcp(ctx, agentId, async (connection) => {
      const conflict = await callToolErr(connection, "memory_rate", {
        id: canonicalId,
        memoryId: aliasId,
        useful: true,
      });
      expect(toolText(conflict).includes(conflictMessage), "MCP conflict error changed");
      const missing = await callToolErr(connection, "memory_rate", { useful: true });
      expect(toolText(missing).includes(missingMessage), "MCP missing identifier error changed");
    });

    const name = `e2e-script-memory-rate-${ctx.nonce}`;
    await upsertScript(ctx, agentId, {
      name,
      source: SOURCE,
      intent: "typecheck memory_rate aliases",
    });
    for (const executor of ["native", "quickjs"]) {
      const taskId = await createPinnedTask(ctx, agentId, `script rating ${executor}`);
      try {
        for (const memoryId of memoryIds) {
          const retrieved = await ctx.api("GET", `/api/memory/${memoryId}?intent=script-rating`, {
            agentId,
            headers: { "X-Source-Task-ID": taskId },
          });
          expectStatus(retrieved, [200], "retrieve memory before rating");
        }
        const run = await runScript(ctx, agentId, {
          name,
          args: {
            canonicalId,
            aliasId,
            matchingId,
            taskId,
            referencesSource: `linear:E2E-${ctx.nonce}-${executor}`,
          },
          executor,
          intent: "verify memory_rate aliases",
        });
        expectRunOk(run, `memory_rate aliases (${executor})`);
        const out = asRecord(run.result);
        for (const key of ["canonical", "alias", "matching"]) {
          const rated = asRecord(out[key]);
          const data = asRecord(rated.data);
          expect(
            rated.success === true &&
              rated.status === 200 &&
              data.applied === 1 &&
              Array.isArray(data.rejected) &&
              data.rejected.length === 0,
            `${executor}: ${key} rating was not applied: ${JSON.stringify(rated)}`,
          );
        }
        expect(out.conflict === conflictMessage, `${executor}: conflict error differs from MCP`);
        expect(
          out.missing === missingMessage,
          `${executor}: missing identifier error differs from MCP`,
        );
        const ratings = ctx.db.query<{ memoryId: string; signal: number; reasoning: string }>(
          sql`SELECT "memoryId", signal, reasoning FROM memory_rating WHERE "taskId" = ${taskId} AND source = 'explicit-self'`,
        );
        expect(ratings.length === 3, `${executor}: expected exactly three persisted ratings`);
        for (const [memoryId, signal] of [
          [canonicalId, 1],
          [aliasId, -1],
          [matchingId, 1],
        ] as const) {
          expect(
            ratings.some(
              (row) =>
                row.memoryId === memoryId &&
                row.signal === signal &&
                row.reasoning === "script rating",
            ),
            `${executor}: persisted rating for ${memoryId} lost its identifier, signal or note`,
          );
        }
      } finally {
        await cancelTask(ctx, taskId);
      }
    }
  },
};
