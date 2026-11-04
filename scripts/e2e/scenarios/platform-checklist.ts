import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { asUser, createUser } from "./core-helpers";

export const platformChecklist: Scenario = {
  name: "platform-checklist",
  order: 652,
  async run(ctx) {
    const userId = await createUser(ctx, "checklist");
    expectStatus(
      await ctx.api("PUT", `/api/users/${userId}/roles`, {
        body: { roles: ["requester"] },
      }),
      [200],
      "assign member role",
    );
    const headers = asUser(userId);
    let response = await ctx.api("GET", "/api/checklist", { headers });
    expectStatus(response, [200], "read checklist");
    const items = asRecords(response.json, "items");
    expect(items.length === 3, "A new user's checklist must have three defaults");
    expect(
      items.map((item) => item.id).join(",") === `swarm:channel,swarm:tool,user:${userId}:use_case`,
      "Default ids and order",
    );
    expect(asRecord(response.json).canEditSwarm === false, "Members cannot edit swarm items");
    expect(items[2]?.editable === true && items[0]?.editable === false, "Item edit permissions");
    expectStatus(
      await ctx.api("PATCH", "/api/checklist/items/swarm:channel", {
        headers,
        body: { action: "remove" },
      }),
      [403],
      "member cannot remove swarm item",
    );
    response = await ctx.api("PATCH", `/api/checklist/items/user:${userId}:use_case`, {
      headers,
      body: { action: "remove", reason: "Already planned elsewhere" },
    });
    expectStatus(response, [200], "member removes own item");
    let item = asRecord(asRecord(response.json).item);
    expect(
      item.status === "removed" &&
        item.statusChangedBy === userId &&
        item.statusReason === "Already planned elsewhere" &&
        typeof item.statusChangedAt === "string",
      "Removal attribution and reason",
    );
    response = await ctx.api("PATCH", "/api/checklist/items/swarm:tool", {
      body: { action: "remove", reason: "Operator deferred" },
    });
    expectStatus(response, [200], "operator removes swarm tool item");
    item = asRecord(asRecord(response.json).item);
    expect(
      item.status === "removed" && item.statusReason === "Operator deferred",
      "Operator removal",
    );
    // The dashboard encodes the id: `swarm%3Atool` must reach the same row.
    response = await ctx.api("PATCH", "/api/checklist/items/swarm%3Atool", {
      body: { action: "restore" },
    });
    expectStatus(response, [200], "operator restores swarm tool item");
    item = asRecord(asRecord(response.json).item);
    expect(
      item.status === "open" &&
        item.statusReason === null &&
        typeof item.statusChangedBy === "string",
      "Restoration clears reason and retains actor",
    );
    response = await ctx.api("POST", "/api/checklist/items", {
      headers,
      body: {
        scope: "user",
        kind: "custom",
        label: `Review plan ${ctx.nonce}`,
        meta: { topic: "Review" },
      },
    });
    expectStatus(response, [201], "member adds custom item");
    item = asRecord(asRecord(response.json).item);
    expect(
      item.userId === userId &&
        item.signal === null &&
        item.done === false &&
        item.editable === true,
      "Custom item contract",
    );
    const itemId = String(item.id);
    response = await ctx.api("PATCH", `/api/checklist/items/${itemId}`, {
      headers,
      body: { action: "done", reason: "Reviewed" },
    });
    expectStatus(response, [200], "member completes custom item");
    item = asRecord(asRecord(response.json).item);
    expect(
      item.done === true &&
        item.status === "done" &&
        item.statusChangedBy === userId &&
        item.statusReason === "Reviewed",
      "Completion attribution",
    );
    expect(
      ctx.db.get<{ status: string }>("SELECT status FROM checklist_items WHERE id = ?", [itemId])
        ?.status === "done",
      "Completion persisted",
    );
  },
};
