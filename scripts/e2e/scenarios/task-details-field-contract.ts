import { expect } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario } from "../run";
import {
  callTool,
  claimTask,
  createAssignedTask,
  expectToolOk,
  registerWorker,
  type ToolOutcome,
  withMcp,
} from "./core-helpers";

// Field contract for get-task-details: whatever shape the response takes, the facts agents act
// on stay reachable from it. A fact counts as reachable when it is in the response itself, in
// the full value behind the response's own overflow pointer (`truncation.fullValueAt`, read with
// kv-get), or in a second call that sets the tool's optional `include` input to every value it
// enumerates. The input schema may only grow optional fields: `taskId` stays the one required one.

type Json = unknown;

/** The value as a record, or {} when it is not one (absent fields are normal here). */
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Every object in a JSON tree, parsing string values that hold JSON objects. */
function objects(
  root: Json,
  out: Record<string, unknown>[] = [],
  depth = 0,
): Record<string, unknown>[] {
  if (depth > 40 || root === null || root === undefined) return out;
  if (typeof root === "string") {
    const t = root.trim();
    if (t.length > 1 && (t.startsWith("{") || t.startsWith("["))) {
      try {
        objects(JSON.parse(t), out, depth + 1);
      } catch {
        // A truncated preview is not JSON; it proves nothing either way.
      }
    }
    return out;
  }
  if (Array.isArray(root)) {
    for (const item of root) objects(item, out, depth + 1);
    return out;
  }
  if (typeof root === "object") {
    const record = root as Record<string, unknown>;
    out.push(record);
    for (const value of Object.values(record)) objects(value, out, depth + 1);
  }
  return out;
}

function hasField(views: Json[], key: string, value: unknown): boolean {
  return views.some((view) => objects(view).some((o) => o[key] === value));
}

/** The values of the optional `include` input, or undefined when the tool has none. */
function includeValues(schema: Record<string, unknown>): string[] | undefined {
  const props = obj(schema.properties);
  if (!("include" in props)) return undefined;
  const include = obj(props.include);
  const items = obj(include.items);
  const values = (Array.isArray(items.enum) ? items.enum : include.enum) as unknown;
  expect(
    Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === "string"),
    `get-task-details include must enumerate its values: ${JSON.stringify(include)}`,
  );
  return values as string[];
}

async function views(
  conn: McpConnection,
  taskId: string,
  include: string[] | undefined,
  includeIsArray: boolean,
): Promise<Json[]> {
  const out: Json[] = [];
  const calls: Record<string, unknown>[] = [{ taskId }];
  if (include) calls.push({ taskId, include: includeIsArray ? include : include[0] });
  for (const args of calls) {
    const outcome: ToolOutcome = await expectToolOk(conn, "get-task-details", args);
    out.push(outcome.data);
    const pointer = obj(outcome.data.truncation).fullValueAt;
    if (typeof pointer === "string" && pointer.startsWith("kv://")) {
      const rest = pointer.slice("kv://".length);
      const cut = rest.indexOf("/");
      const full = await expectToolOk(conn, "kv-get", {
        namespace: rest.slice(0, cut),
        key: rest.slice(cut + 1),
      });
      out.push(full.data);
    }
  }
  return out;
}

export const taskDetailsFieldContract: Scenario = {
  name: "task-details-field-contract",
  order: 268,
  async run(ctx) {
    const worker = await registerWorker(ctx, "details-contract");
    await withMcp(ctx, worker, async (conn) => {
      const tools = (await conn.listTools()) as Array<{ name: string; inputSchema: unknown }>;
      const tool = tools.find((t) => t.name === "get-task-details");
      expect(tool !== undefined, "get-task-details is not listed");
      const schema = obj(tool?.inputSchema);
      const required = Array.isArray(schema.required) ? schema.required : [];
      expect(
        required.length === 1 && required[0] === "taskId",
        `get-task-details must require exactly taskId, got ${JSON.stringify(required)}`,
      );
      expect(
        obj(obj(schema.properties).taskId).type === "string",
        "get-task-details taskId must stay a string",
      );
      const include = includeValues(schema);
      const includeIsArray = obj(obj(schema.properties).include).type === "array";

      // Parent: completed, an attachment, many progress lines and an output large enough
      // that today's full response passes the 10 KB wire limit.
      const parentId = await createAssignedTask(ctx, worker, `Field contract parent ${ctx.nonce}`);
      await claimTask(ctx, worker, parentId);
      for (let i = 0; i < 12; i++) {
        await expectToolOk(conn, "store-progress", {
          taskId: parentId,
          progress: `step ${i} of the field contract ${ctx.nonce} ${"x".repeat(200)}`,
        });
      }
      const attachmentUrl = `https://example.com/field-contract/${ctx.nonce}.md`;
      const output = `Parent result ${ctx.nonce}\n${"Measured row. ".repeat(900)}`;
      await expectToolOk(conn, "store-progress", {
        taskId: parentId,
        status: "completed",
        output,
        attachments: [{ kind: "url", url: attachmentUrl, name: `report-${ctx.nonce}` }],
      });

      // Child: failed with a reason, linked to the parent.
      const childId = await createAssignedTask(ctx, worker, `Field contract child ${ctx.nonce}`, {
        parentTaskId: parentId,
      });
      await claimTask(ctx, worker, childId);
      const failureReason = `child failed on purpose ${ctx.nonce}`;
      await expectToolOk(conn, "store-progress", {
        taskId: childId,
        status: "failed",
        failureReason,
      });

      const parent = await views(conn, parentId, include, includeIsArray);
      expect(hasField(parent, "id", parentId), "parent id unreachable");
      expect(hasField(parent, "status", "completed"), "parent status unreachable");
      expect(hasField(parent, "output", output), "parent output unreachable in full");
      expect(hasField(parent, "url", attachmentUrl), "parent attachment unreachable");

      const child = await views(conn, childId, include, includeIsArray);
      expect(hasField(child, "id", childId), "child id unreachable");
      expect(hasField(child, "status", "failed"), "child status unreachable");
      expect(hasField(child, "failureReason", failureReason), "child failureReason unreachable");
      expect(hasField(child, "parentTaskId", parentId), "child parentTaskId unreachable");

      // A missing task still errors.
      const ghost = await callTool(conn, "get-task-details", {
        taskId: "00000000-0000-4000-8000-00000000beef",
      });
      expect(ghost.isError, "get-task-details on a missing task did not error");
    });
  },
};
