import { afterEach, beforeEach, expect, test } from "bun:test";
import * as db from "../be/db";

beforeEach(() => db.initDb(":memory:"));
afterEach(() => db.closeDb());

const worker = { name: "Worker", isLead: false, status: "idle" as const };

test("context history keeps version ordering, limits, hashes and null defaults", async () => {
  const agent = await db.createAgent(worker);
  const versions = [];
  for (const version of [2, 1, 3]) {
    versions.push(
      await db.createContextVersion({
        agentId: agent.id,
        field: "soulMd",
        content: `v${version}`,
        version,
        changeSource: "system",
        contentHash: db.computeContentHash(`v${version}`),
      }),
    );
  }
  expect(
    (await db.getContextVersionHistory({ agentId: agent.id, field: "soulMd", limit: 2 })).map(
      (v) => v.version,
    ),
  ).toEqual([3, 2]);
  expect(await db.getLatestContextVersion(agent.id, "soulMd")).toEqual(versions[2]);
  expect(await db.getContextVersion(versions[0]!.id)).toEqual(versions[0]!);
  expect(versions[0]).toMatchObject({
    changedByAgentId: null,
    changeReason: null,
    previousVersionId: null,
  });
  expect(await db.getLatestContextVersion(agent.id, "toolsMd")).toBeNull();
});
