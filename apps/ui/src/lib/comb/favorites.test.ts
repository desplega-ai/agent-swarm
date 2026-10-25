import { describe, expect, test } from "bun:test";
import {
  dashboardPinsToMove,
  favoriteApiPath,
  favoriteCombPath,
  favoritePinIds,
  favoritesImportKey,
  starsToImport,
  withFavorite,
} from "./favorites";

const drive = { orgId: "o", driveId: "d" };

describe("favorite paths", () => {
  test("a folder star gets its trailing slash in Comb and loses it for agent-fs", () => {
    expect(favoriteCombPath({ path: "/docs", kind: "directory" })).toBe("/docs/");
    expect(favoriteCombPath({ path: "docs/a.md", kind: "file" })).toBe("/docs/a.md");
    expect(favoriteApiPath("/docs/")).toBe("/docs");
    expect(favoriteApiPath("/docs/a.md")).toBe("/docs/a.md");
  });

  test("pin ids come newest first", () => {
    const ids = favoritePinIds(
      [
        { path: "/a.md", kind: "file", createdAt: "2026-10-01T00:00:00Z" },
        { path: "/notes", kind: "directory", createdAt: "2026-10-20T00:00:00Z" },
      ],
      drive,
    );
    expect(ids).toEqual(["o/d/notes/", "o/d/a.md"]);
  });
});

describe("withFavorite", () => {
  const list = [{ path: "/a.md", kind: "file" as const, createdAt: "2026-10-01T00:00:00Z" }];

  test("a star goes on top, a second star of the same path moves it", () => {
    const next = withFavorite(list, "/docs/", true, "2026-10-25T00:00:00Z");
    expect(next[0]).toEqual({
      path: "/docs",
      kind: "directory",
      createdAt: "2026-10-25T00:00:00Z",
    });
    expect(withFavorite(next, "/a.md", true, "2026-10-26T00:00:00Z").map((f) => f.path)).toEqual([
      "/a.md",
      "/docs",
    ]);
  });

  test("an unstar drops the path", () => {
    expect(withFavorite(list, "/a.md", false, "x")).toEqual([]);
  });
});

describe("dashboardPinsToMove", () => {
  test("only valid pins on this drive", () => {
    expect(
      dashboardPinsToMove(["o/d/a.md", "o/other/b.md", "o/d/docs/", "bad", "o/d/../x"], drive),
    ).toEqual([
      { orgId: "o", driveId: "d", path: "/a.md" },
      { orgId: "o", driveId: "d", path: "/docs/" },
    ]);
  });
});

describe("the import of dashboard stars", () => {
  test("only stars agent-fs does not have, never the drive root", () => {
    const stars = [{ path: "/docs", kind: "directory" as const, createdAt: "x" }];
    expect(starsToImport(["o/d/docs/", "o/d/a.md", "o/d/", "o/x/b.md"], stars, drive)).toEqual([
      { orgId: "o", driveId: "d", path: "/a.md" },
    ]);
  });

  test("the marker is per agent-fs server, user, and drive", () => {
    expect(favoritesImportKey("https://fs", "u1", drive)).toBe(
      "comb:favorites-imported:https://fs|u1|o/d",
    );
    expect(favoritesImportKey("https://fs", "u2", drive)).not.toBe(
      favoritesImportKey("https://fs", "u1", drive),
    );
  });
});
