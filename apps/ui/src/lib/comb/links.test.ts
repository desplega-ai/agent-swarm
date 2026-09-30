import { describe, expect, test } from "bun:test";
import {
  appUrlToCombPath,
  combLinkFor,
  combPathForLink,
  drivePathToLiveUrl,
  encodedPathToCombPath,
  isCombNavigable,
  liveUrlToCombPath,
} from "./links";

const LIVE = "https://live.agent-fs.dev";
const APP = "http://localhost:5274";
const IDS = { orgId: "org-1", driveId: "drive-1" };
const NOT_READY = ["disabled", "loading", "needs-connect", "invalid-key", "unreachable"] as const;

/** A live link into org-1/drive-1, mapped to its Comb route. */
function live(path: string): string | null {
  return liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1/${path}`, LIVE);
}

describe("liveUrlToCombPath", () => {
  test("maps live /file/~/ and /detail/~/ links to the Comb route", () => {
    expect(liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1/comb-qa/notes.md`, LIVE)).toBe(
      "/file/~/org-1/drive-1/comb-qa/notes.md",
    );
    expect(liveUrlToCombPath(`${LIVE}/detail/~/org-1/drive-1/comb-qa/notes.md`, LIVE)).toBe(
      "/file/~/org-1/drive-1/comb-qa/notes.md",
    );
  });

  test("maps folders and the drive root", () => {
    expect(live("comb-qa/")).toBe("/file/~/org-1/drive-1/comb-qa/");
    expect(live("")).toBe("/file/~/org-1/drive-1/");
    expect(liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1`, LIVE)).toBe("/file/~/org-1/drive-1/");
  });

  test("accepts a trailing slash or a path prefix on the live URL", () => {
    const href = `${LIVE}/file/~/org-1/drive-1/notes.md`;
    expect(liveUrlToCombPath(href, `${LIVE}/`)).toBe("/file/~/org-1/drive-1/notes.md");
    expect(liveUrlToCombPath(`${LIVE}/live/file/~/org-1/drive-1/notes.md`, `${LIVE}/live/`)).toBe(
      "/file/~/org-1/drive-1/notes.md",
    );
    expect(liveUrlToCombPath(href, `${LIVE}/live`)).toBeNull();
  });

  test("keeps ?comment= and drops other query params and the hash", () => {
    expect(live("notes.md?comment=c%201&x=1#top")).toBe(
      "/file/~/org-1/drive-1/notes.md?comment=c%201",
    );
    expect(live("notes.md?x=1")).toBe("/file/~/org-1/drive-1/notes.md");
  });

  test("leaves foreign and malformed URLs alone", () => {
    for (const href of [
      "https://example.com/file/~/org-1/drive-1/notes.md",
      "http://live.agent-fs.dev/file/~/org-1/drive-1/notes.md",
      `${LIVE}/files/~/org-1/drive-1/notes.md`,
      `${LIVE}/file/org-1/drive-1/notes.md`,
      `${LIVE}/file/~/`,
      `${LIVE}/file/~/org-1`,
      "/file/~/org-1/drive-1/notes.md",
      "notes.md",
      "mailto:someone@example.com",
      "",
    ]) {
      expect(liveUrlToCombPath(href, LIVE)).toBeNull();
    }
    expect(liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1/notes.md`, null)).toBeNull();
  });

  test("decodes each segment once and encodes it once for the route", () => {
    expect(live("a%20b.md")).toBe("/file/~/org-1/drive-1/a%20b.md");
    expect(live("a b.md")).toBe("/file/~/org-1/drive-1/a%20b.md");
    // A file literally named "a%20b.md" arrives double-encoded and keeps its name.
    expect(live("a%2520b.md")).toBe("/file/~/org-1/drive-1/a%2520b.md");
    expect(live("caf%C3%A9/%231.md")).toBe("/file/~/org-1/drive-1/caf%C3%A9/%231.md");
  });

  test("rejects paths that leave the drive, now or after the router decodes again", () => {
    for (const path of [
      // Dot segments, in any spelling, before the URL parser resolves them.
      "../secret.md",
      "./secret.md",
      "a/../b.md",
      "a/%2E/b.md",
      "%2e%2e/secret.md",
      ".%2e/secret.md",
      "%2e%2e/%2e%2e/%2e%2e/x",
      String.raw`..\secret.md`,
      // A decoded "/", "\", or "..": never split into more segments.
      "a%2Fb.md",
      "a%5Cb.md",
      "..%2fsecret.md",
      "%2e%2e%2fsecret.md",
      // Double-encoded: one decode leaves "%2e%2e" or "%2F". The router's
      // decode would make it ".." or "/".
      "%252e%252e/%252e%252e/settings",
      "%252e%252e",
      "a%252Fb.md",
      "a%255Cb.md",
      // Malformed escapes.
      "bad%E0%A4%A.md",
    ]) {
      expect(live(path)).toBeNull();
    }
    expect(liveUrlToCombPath(`${LIVE}/file/~/org%2F1/drive-1/b.md`, LIVE)).toBeNull();
  });
});

describe("appUrlToCombPath", () => {
  test("maps server-written dashboard links on the same origin", () => {
    expect(appUrlToCombPath(`${APP}/file/~/org-1/drive-1/comb-qa/notes.md`, APP)).toBe(
      "/file/~/org-1/drive-1/comb-qa/notes.md",
    );
    expect(appUrlToCombPath("/file/~/org-1/drive-1/comb-qa/", APP)).toBe(
      "/file/~/org-1/drive-1/comb-qa/",
    );
    expect(appUrlToCombPath(`${APP}/file/~/org-1/drive-1/a%20b.md?comment=c1`, APP)).toBe(
      "/file/~/org-1/drive-1/a%20b.md?comment=c1",
    );
  });

  test("leaves other origins, other routes, and relative hrefs alone", () => {
    for (const href of [
      "https://app.agent-swarm.dev/file/~/org-1/drive-1/x.md",
      `${APP}.evil.test/file/~/org-1/drive-1/x.md`,
      "//evil.test/file/~/org-1/drive-1/x.md",
      String.raw`/\evil.test/file/~/org-1/drive-1/x.md`,
      "file/~/org-1/drive-1/x.md",
      "./file/~/org-1/drive-1/x.md",
      `${APP}/detail/~/org-1/drive-1/x.md`,
      `${APP}/tasks/123`,
      "/file/~/org-1/drive-1/%252e%252e/settings",
      "/file/~/org-1/drive-1/../../settings",
      "#section",
    ]) {
      expect(appUrlToCombPath(href, APP)).toBeNull();
    }
  });
});

describe("combPathForLink", () => {
  test("tries the live URL first, then the dashboard origin", () => {
    const opts = { liveUrl: LIVE, appOrigin: APP };
    expect(combPathForLink(`${LIVE}/file/~/org-1/drive-1/x.md`, opts)).toBe(
      "/file/~/org-1/drive-1/x.md",
    );
    expect(combPathForLink(`${APP}/file/~/org-1/drive-1/x.md`, opts)).toBe(
      "/file/~/org-1/drive-1/x.md",
    );
    expect(combPathForLink("https://example.com/x", opts)).toBeNull();
  });
});

describe("isCombNavigable", () => {
  test("only a connected Comb is navigable", () => {
    expect(isCombNavigable("ready")).toBe(true);
    for (const state of NOT_READY) {
      expect(isCombNavigable(state)).toBe(false);
    }
  });
});

describe("combLinkFor", () => {
  const href = `${LIVE}/file/~/org-1/drive-1/notes.md`;

  test("maps a link only while Comb is ready", () => {
    expect(combLinkFor("ready", LIVE, APP, href)).toBe("/file/~/org-1/drive-1/notes.md");
    for (const state of NOT_READY) {
      expect(combLinkFor(state, LIVE, APP, href)).toBeNull();
    }
  });

  test("returns null for a missing or foreign href", () => {
    expect(combLinkFor("ready", LIVE, APP, null)).toBeNull();
    expect(combLinkFor("ready", LIVE, APP, "")).toBeNull();
    expect(combLinkFor("ready", LIVE, APP, "https://example.com/x")).toBeNull();
  });
});

describe("encodedPathToCombPath", () => {
  test("builds the route from ids and an encoded path", () => {
    expect(encodedPathToCombPath({ ...IDS, encodedPath: "comb-qa/notes.md" })).toBe(
      "/file/~/org-1/drive-1/comb-qa/notes.md",
    );
    expect(encodedPathToCombPath({ ...IDS, encodedPath: "shared%20reports/a%2520b.md" })).toBe(
      "/file/~/org-1/drive-1/shared%20reports/a%2520b.md",
    );
    expect(encodedPathToCombPath({ ...IDS, encodedPath: "docs/" })).toBe(
      "/file/~/org-1/drive-1/docs/",
    );
  });

  test("uses the same containment rules as links", () => {
    for (const encodedPath of ["../settings", "%2e%2e/x", "%252e%252e/x", "a%2Fb", "a%252Fb"]) {
      expect(encodedPathToCombPath({ ...IDS, encodedPath })).toBeNull();
    }
    expect(encodedPathToCombPath({ orgId: "org/1", driveId: "d", encodedPath: "x" })).toBeNull();
  });
});

describe("drivePathToLiveUrl", () => {
  test("builds the live URL from decoded names", () => {
    expect(drivePathToLiveUrl({ ...IDS, path: "/a b.md" }, `${LIVE}/`)).toBe(
      `${LIVE}/file/~/org-1/drive-1/a%20b.md`,
    );
    expect(drivePathToLiveUrl({ ...IDS, path: "/a%20b.md" }, LIVE)).toBe(
      `${LIVE}/file/~/org-1/drive-1/a%2520b.md`,
    );
    expect(drivePathToLiveUrl({ ...IDS, path: "/" }, LIVE)).toBe(`${LIVE}/file/~/org-1/drive-1/`);
    expect(drivePathToLiveUrl({ ...IDS, path: "/docs/" }, LIVE)).toBe(
      `${LIVE}/file/~/org-1/drive-1/docs/`,
    );
  });

  test("returns null for a name that leaves the drive", () => {
    // The router hands "%2e%2e" for a `%252e%252e` route segment.
    for (const path of ["/%2e%2e/settings", "/../settings", "/a%2Fb.md", String.raw`/a\b.md`]) {
      expect(drivePathToLiveUrl({ ...IDS, path }, LIVE)).toBeNull();
    }
    expect(drivePathToLiveUrl({ orgId: "..", driveId: "d", path: "/x" }, LIVE)).toBeNull();
  });
});
