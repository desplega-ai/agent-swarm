import { expect, test } from "bun:test";
import type { UserFavorite } from "../api/types";
import { favoriteHref, favoriteKind, mergeFavorites } from "./home-favorites";

test("each favorite type opens its own route", () => {
  expect(favoriteHref("key", "shared/po-qa/")).toBe("/sessions?view=shared%2Fpo-qa%2F");
  expect(favoriteHref("page", "p1")).toBe("/pages/p1");
  expect(favoriteHref("workflow", "w1")).toBe("/workflows/w1");
  expect(favoriteHref("schedule", "s1")).toBe("/schedules/s1");
  expect(favoriteHref("agent-fs-path", "org/drive/shared/po-qa/report.md")).toBe(
    "/file/~/org/drive/shared/po-qa/report.md",
  );
  expect(favoriteHref("agent-fs-path", "not-a-pin")).toBeNull();
});

test("kind labels, a folder pin reads as Folder", () => {
  expect(favoriteKind("key", "shared/po-qa/")).toBe("Use case");
  expect(favoriteKind("agent-fs-path", "org/drive/shared/po-qa/")).toBe("Folder");
  expect(favoriteKind("agent-fs-path", "org/drive/shared/po-qa/a.md")).toBe("File");
  expect(favoriteKind("schedule", "s1")).toBe("Schedule");
});

test("favorites of every type merge newest star first", () => {
  const fav = (itemType: UserFavorite["itemType"], itemId: string, createdAt: string) =>
    ({ id: itemId, itemType, itemId, createdAt, lastUpdatedAt: createdAt }) as UserFavorite;
  const merged = mergeFavorites([
    [fav("key", "shared/a/", "2026-11-04T10:00:00Z")],
    undefined,
    [fav("page", "p1", "2026-11-04T11:00:00Z")],
  ]);
  expect(merged.map((f) => f.itemId)).toEqual(["p1", "shared/a/"]);
});
