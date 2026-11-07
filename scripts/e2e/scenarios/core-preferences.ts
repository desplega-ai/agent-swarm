import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { asUser, createUser } from "./core-helpers";

/** Favorites are scoped to the caller: the dashboard operator and each user keep their own. */
async function favorites(ctx: ScenarioContext, userId: string) {
  const itemId = `core-wf-${ctx.nonce}`;
  const other = `core-page-${ctx.nonce}`;
  const put = (
    favorite: boolean,
    headers: Record<string, string> = {},
    id = itemId,
    type = "workflow",
  ) =>
    ctx.api("PUT", "/api/favorites", { headers, body: { itemType: type, itemId: id, favorite } });

  let response = await put(true);
  expectStatus(response, [200], "operator favorites an item");
  let body = asRecord(response.json);
  const row = asRecord(body.row);
  expect(
    body.favorite === true && body.itemType === "workflow" && body.itemId === itemId,
    `Favorite response ${response.text}`,
  );
  expect(
    typeof row.id === "string" && !("userId" in row),
    "An operator favorite must not name a user",
  );
  expect(
    ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_favorites WHERE itemId = ?", [itemId])
      ?.n === 1,
    "user_favorites lacks the favorite",
  );
  response = await put(true);
  expectStatus(response, [200], "favoriting twice");
  expect(
    ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_favorites WHERE itemId = ?", [itemId])
      ?.n === 1,
    "A repeated favorite duplicated the row",
  );

  // A user keeps a separate set.
  response = await put(true, asUser(userId), other, "page");
  expectStatus(response, [200], "user favorites a page");
  expect(asRecord(asRecord(response.json).row).userId === userId, "User favorite lost its owner");
  response = await ctx.api("GET", "/api/favorites", { headers: asUser(userId) });
  expectStatus(response, [200], "user favorites list");
  expect(
    JSON.stringify(asRecord(response.json).favoriteIds) === JSON.stringify([other]),
    `The user should see only their own favorite: ${response.text}`,
  );
  response = await ctx.api("GET", "/api/favorites?itemType=workflow");
  expectStatus(response, [200], "operator favorites, filtered by type");
  body = asRecord(response.json);
  expect(
    Array.isArray(body.favoriteIds) &&
      body.favoriteIds.includes(itemId) &&
      !body.favoriteIds.includes(other),
    "The operator list leaked the user's favorite",
  );
  response = await ctx.api("GET", `/api/favorites?itemIds=${itemId},missing-${ctx.nonce}`);
  expect(
    JSON.stringify(asRecord(response.json).favoriteIds) === JSON.stringify([itemId]),
    "itemIds did not narrow the list",
  );
  expect(asRecords(response.json, "favorites").length === 1, "favorites rows differ from ids");

  // Unfavoriting removes the row and keeps answering 200.
  response = await put(false);
  expectStatus(response, [200], "operator unfavorites");
  expect(
    asRecord(response.json).favorite === false && asRecord(response.json).row === null,
    "unfavorite",
  );
  response = await put(false);
  expectStatus(response, [200], "unfavorite again");
  response = await put(false, asUser(userId), other, "page");
  expectStatus(response, [200], "user unfavorites");
  response = await ctx.api("GET", "/api/favorites?itemType=workflow");
  expect(
    !(asRecord(response.json).favoriteIds as string[]).includes(itemId),
    "The favorite survived unfavoriting",
  );

  expectStatus(
    await ctx.api("PUT", "/api/favorites", {
      body: { itemType: "dashboard", itemId: "x", favorite: true },
    }),
    [400],
    "unknown item type",
  );
  expectStatus(
    await ctx.api("PUT", "/api/favorites", {
      body: { itemType: "page", itemId: "", favorite: true },
    }),
    [400],
    "empty item id",
  );
  expectStatus(
    await ctx.api("PUT", "/api/favorites", {
      apiKey: null,
      body: { itemType: "page", itemId: "x", favorite: true },
    }),
    [401],
    "favorite without credentials",
  );
}

/** Per-user inbox state: dismiss, snooze, done. */
async function inboxState(ctx: ScenarioContext, userId: string) {
  const snoozeUntil = "2099-01-01T00:00:00.000Z";
  let response = await ctx.api("PATCH", "/api/inbox-state", {
    body: {
      userId,
      itemType: "to_read",
      itemId: `core-item-${ctx.nonce}`,
      status: "snoozed",
      snoozeUntil,
    },
  });
  expectStatus(response, [200], "snooze an item");
  let item = asRecord(asRecord(response.json).item);
  expect(
    item.userId === userId && item.status === "snoozed" && item.snoozeUntil === snoozeUntil,
    `Snoozed item ${response.text}`,
  );
  const itemRowId = String(item.id);

  response = await ctx.api("PATCH", "/api/inbox-state", {
    body: { userId, itemType: "to_read", itemId: `core-item-${ctx.nonce}`, status: "done" },
  });
  expectStatus(response, [200], "mark the same item done");
  item = asRecord(asRecord(response.json).item);
  expect(
    item.id === itemRowId && item.status === "done" && typeof item.doneAt === "string",
    "The upsert must update the same row and stamp doneAt",
  );

  response = await ctx.api("PATCH", "/api/inbox-state/bulk", {
    body: {
      userId,
      items: [
        { itemType: "notification", itemId: `core-n1-${ctx.nonce}`, status: "dismissed" },
        { itemType: "notification", itemId: `core-n2-${ctx.nonce}`, status: "open" },
        { itemType: "approval", itemId: `core-a1-${ctx.nonce}`, status: "done" },
      ],
    },
  });
  expectStatus(response, [200], "bulk upsert");
  const bulk = asRecords(response.json, "items");
  expect(
    bulk.length === 3 &&
      bulk[0]?.status === "dismissed" &&
      typeof bulk[0]?.dismissedAt === "string" &&
      bulk[2]?.itemType === "approval",
    `Bulk result keeps request order: ${response.text}`,
  );

  const list = async (qs: string) => {
    const result = await ctx.api("GET", `/api/inbox-state?userId=${userId}${qs}`);
    expectStatus(result, [200], `inbox state ${qs}`);
    return asRecords(result.json, "items");
  };
  expect((await list("")).length === 4, "The user should have 4 inbox rows");
  expect((await list("&status=done")).length === 2, "status=done should match 2");
  expect((await list("&itemType=notification")).length === 2, "itemType filter should match 2");
  expect((await list("&status=done&itemType=approval")).length === 1, "combined filter");
  response = await ctx.api("GET", `/api/inbox-state?userId=nobody-${ctx.nonce}`);
  expect(asRecords(response.json, "items").length === 0, "Another user's inbox is not empty");

  expectStatus(await ctx.api("GET", "/api/inbox-state"), [400], "inbox state without a user");
  expectStatus(
    await ctx.api("PATCH", "/api/inbox-state", {
      body: { userId, itemType: "bogus", itemId: "x", status: "open" },
    }),
    [400],
    "unknown item type",
  );
  expectStatus(
    await ctx.api("PATCH", "/api/inbox-state/bulk", { body: { userId, items: [] } }),
    [400],
    "empty bulk",
  );
  expectStatus(
    await ctx.api("PATCH", "/api/inbox-state", {
      apiKey: null,
      body: { userId, itemType: "to_read", itemId: "x", status: "open" },
    }),
    [401],
    "inbox write without credentials",
  );
}

/** The seeded "To start" templates. */
async function taskTemplates(ctx: ScenarioContext) {
  let response = await ctx.api("GET", "/api/task-templates");
  expectStatus(response, [200], "task templates");
  const templates = asRecords(response.json, "templates");
  expect(templates.length > 0, "No seeded task templates");
  expect(
    templates.every(
      (template) =>
        typeof template.title === "string" &&
        typeof template.prompt === "string" &&
        typeof template.description === "string",
    ),
    "A template lacks title, description or prompt",
  );
  const sample = templates.find((template) => typeof template.category === "string");
  expect(sample !== undefined, "No template carries a category");
  response = await ctx.api(
    "GET",
    `/api/task-templates?category=${encodeURIComponent(String(sample.category))}`,
  );
  const filtered = asRecords(response.json, "templates");
  expect(
    filtered.length > 0 && filtered.every((template) => template.category === sample.category),
    "The category filter returned another category",
  );
  response = await ctx.api(
    "GET",
    `/api/task-templates?query=${encodeURIComponent(String(sample.title).toUpperCase())}`,
  );
  expect(
    asRecords(response.json, "templates").some((template) => template.id === sample.id),
    "The query filter is not a case-insensitive title match",
  );
  response = await ctx.api(
    "GET",
    `/api/task-templates?query=${encodeURIComponent(`nothing-${ctx.nonce}`)}`,
  );
  expect(asRecords(response.json, "templates").length === 0, "A nonsense query matched templates");
  response = await ctx.api("GET", "/api/task-templates?kind=schedule");
  expectStatus(response, [200], "templates, kind filter");
  expect(
    asRecords(response.json, "templates").every((template) => template.kind === "schedule"),
    "The kind filter returned another kind",
  );
  expectStatus(await ctx.api("GET", "/api/task-templates?kind=bogus"), [400], "unknown kind");
  expectStatus(
    await ctx.api("GET", "/api/task-templates", { apiKey: null }),
    [401],
    "templates without credentials",
  );
}

export const corePreferences: Scenario = {
  name: "core-preferences",
  order: 260,
  async run(ctx) {
    const userId = await createUser(ctx, "preferences");
    await favorites(ctx, userId);
    await inboxState(ctx, userId);
    await taskTemplates(ctx);
  },
};
