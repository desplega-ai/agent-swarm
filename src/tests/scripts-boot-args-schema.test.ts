import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb } from "../be/db";
import { runBootArgsSchemaBackfill } from "../be/scripts/boot-args-schema";
import { getScript, listScriptVersions, upsertScriptByName } from "../be/scripts/db";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";
import { CHILD_PROCESS_TEST_BUDGET_MS } from "./test-proc";

const TEST_DB_PATH = "./test-scripts-boot-args-schema.sqlite";
const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

const signatureJson = JSON.stringify({
  argsType: "{ n: number }",
  resultType: "Promise<number>",
  description: "",
});

const defaultedSource = `
import { z } from "zod";
export const argsSchema = z.object({ n: z.number(), scale: z.number().default(2) });
export default async (args: z.infer<typeof argsSchema>) => args.n * args.scale;
`;

// What `toJSONSchema(argsSchema)` produced before `io: "input"`: `scale` is required.
const STALE_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { n: { type: "number" }, scale: { default: 2, type: "number" } },
  required: ["n", "scale"],
  additionalProperties: false,
});

async function clearDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
}

async function seed(
  name: string,
  overrides: Partial<Parameters<typeof upsertScriptByName>[0]> = {},
) {
  const { script } = await upsertScriptByName({
    name,
    scope: "global",
    source: defaultedSource,
    description: "Script with a defaulted arg",
    intent: "Boot args schema backfill test",
    signatureJson,
    argsJsonSchema: STALE_SCHEMA,
    embeddingMode: "skip",
    ...overrides,
  });
  return script;
}

function requiredOf(schema: string | null | undefined): string[] {
  return (JSON.parse(schema as string) as { required: string[] }).required;
}

/** Runs the backfill and returns its `rewrote N of M` summary line. */
async function runAndReadSummary(): Promise<string | undefined> {
  const log = spyOn(console, "log");
  try {
    await runBootArgsSchemaBackfill();
    return log.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith("[boot-args-schema]"));
  } finally {
    log.mockRestore();
  }
}

beforeAll(async () => {
  await clearDb();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await clearDb();
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM scripts");
});

describe("boot-args-schema backfill", () => {
  spawnTest(
    "fixes a stale schema in place for every scope, then a second run rewrites 0",
    async () => {
      const global = await seed("stale-global");
      const agent = await seed("stale-agent", { scope: "agent", scopeId: "agent-1" });
      expect(requiredOf(global.argsJsonSchema)).toEqual(["n", "scale"]);

      expect(await runAndReadSummary()).toBe("[boot-args-schema] rewrote 2 of 2 script schemas");

      for (const before of [global, agent]) {
        const after = await getScript({
          name: before.name,
          scope: before.scope,
          scopeId: before.scopeId,
        });
        const schema = JSON.parse(after?.argsJsonSchema as string) as {
          required: string[];
          properties: { scale: { default: number } };
        };
        expect(schema.required).toEqual(["n"]);
        expect(schema.properties.scale.default).toBe(2);
        // In place: same version, same timestamps, no new history row.
        expect(after?.version).toBe(before.version);
        expect(after?.updatedAt).toBe(before.updatedAt);
        expect(await listScriptVersions(before.id)).toHaveLength(1);
      }

      expect(await runAndReadSummary()).toBe("[boot-args-schema] rewrote 0 of 2 script schemas");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  spawnTest(
    "keeps the stored schema when extraction finds none, and skips scratch and schema-less rows",
    async () => {
      const noSchemaSource = "export default async () => 1;";
      const keep = await seed("no-argsschema-source", { source: noSchemaSource });
      await seed("scratch-stale", { scope: "agent", scopeId: "agent-1", isScratch: true });
      await seed("never-had-schema", { argsJsonSchema: null });

      // Only `keep` is examined: the scratch row and the null-schema row are filtered out.
      expect(await runAndReadSummary()).toBe("[boot-args-schema] rewrote 0 of 1 script schemas");

      const after = await getScript({ name: keep.name, scope: "global" });
      expect(after?.argsJsonSchema).toBe(STALE_SCHEMA);
      const scratch = await getScript({
        name: "scratch-stale",
        scope: "agent",
        scopeId: "agent-1",
      });
      expect(scratch?.argsJsonSchema).toBe(STALE_SCHEMA);
      const bare = await getScript({ name: "never-had-schema", scope: "global" });
      expect(bare?.argsJsonSchema).toBeNull();
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test("no-ops without logging when no script has a stored schema", async () => {
    await seed("bare", { argsJsonSchema: null });
    expect(await runAndReadSummary()).toBeUndefined();
  });
});
