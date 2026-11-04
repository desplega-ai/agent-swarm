import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { parseAppDefinition } from "../apps/definition";
import { createApp, getApp, listApps, updateApp } from "../apps/store";
import { closeDb, getDbClient, initDb } from "../be/db";

const TEST_DB_PATH = `/private/tmp/test-apps-icon-${process.pid}.sqlite`;

const baseDefinition = {
  models: {},
  queries: {},
  actions: {},
  pages: {
    main: {
      title: "Main",
      root: "root",
      elements: { root: { type: "Stack", props: {}, children: [] } },
    },
  },
  defaultPage: "main",
};

async function createWithIcon(name: string, icon: unknown) {
  const parsed = await parseAppDefinition(baseDefinition, { writerIsUser: true });
  if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
  const app = await createApp({ name, definition: parsed.definition });
  if (icon !== undefined) {
    // Write the raw column so malformed stored icons (hand edits, old data) can be exercised.
    const stored = { ...parsed.definition, icon };
    await getDbClient().run("UPDATE apps SET definition = ? WHERE id = ?", [
      JSON.stringify(stored),
      app.id,
    ]);
  }
  return app.id;
}

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
});

describe("app icon", () => {
  test("definition accepts a lucide icon and rejects a malformed one", async () => {
    const icon = { type: "lucide", icon: "layout-grid", color: "#f59e0b" };
    expect((await parseAppDefinition({ ...baseDefinition, icon })).success).toBe(true);
    expect(
      (await parseAppDefinition({ ...baseDefinition, icon: { type: "lucide", icon: "Not Valid" } }))
        .success,
    ).toBe(false);
    expect(
      (
        await parseAppDefinition({
          ...baseDefinition,
          icon: { type: "lucide", icon: "star", color: "red" },
        })
      ).success,
    ).toBe(false);
  });

  test('suggests "icon" for avatar and emoji top-level keys', async () => {
    for (const key of ["avatar", "emoji"]) {
      const parsed = await parseAppDefinition({ ...baseDefinition, [key]: "x" });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.issues.some((issue) => issue.message.includes('did you mean "icon"'))).toBe(
          true,
        );
      }
    }
  });

  test("an icon written through the normal create and update path survives to listApps", async () => {
    const icon = { type: "lucide", icon: "layout-grid", color: "#f59e0b" };
    const parsed = await parseAppDefinition({ ...baseDefinition, icon }, { writerIsUser: true });
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
    const app = await createApp({ name: "Round trip", definition: parsed.definition });

    expect((await listApps()).find((summary) => summary.id === app.id)?.icon).toEqual(icon);
    expect((await getApp(app.id))?.definition.icon).toEqual(icon);

    const nextIcon = { type: "lucide", icon: "star" };
    const reparsed = await parseAppDefinition(
      { ...baseDefinition, icon: nextIcon },
      { writerIsUser: true },
    );
    if (!reparsed.success) throw new Error(JSON.stringify(reparsed.issues));
    await updateApp(app.id, { definition: reparsed.definition });

    expect((await listApps()).find((summary) => summary.id === app.id)?.icon).toEqual(nextIcon);
  });

  test("listApps projects a valid icon and omits it when absent or invalid", async () => {
    const icon = { type: "lucide", icon: "layout-grid", color: "#f59e0b" };
    const withIcon = await createWithIcon("With icon", icon);
    const withoutIcon = await createWithIcon("Without icon", undefined);
    const badShape = await createWithIcon("Bad shape", { type: "lucide", icon: "Not Valid" });
    const wrongType = await createWithIcon("Wrong type", "star");

    const byId = new Map((await listApps()).map((app) => [app.id, app]));
    expect(byId.get(withIcon)?.icon).toEqual(icon);
    for (const id of [withoutIcon, badShape, wrongType]) {
      const summary = byId.get(id);
      expect(summary).toBeDefined();
      expect(summary && "icon" in summary).toBe(false);
    }
  });

  test("an unknown but well-formed icon name is passed through for the dashboard to fall back on", async () => {
    const icon = { type: "lucide", icon: "no-such-icon" };
    const id = await createWithIcon("Unknown icon", icon);
    const summary = (await listApps()).find((app) => app.id === id);
    expect(summary?.icon).toEqual(icon);
  });
});
