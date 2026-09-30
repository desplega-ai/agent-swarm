import { describe, expect, test } from "bun:test";
import {
  appUrlToCombPath,
  combPathForLink,
  fileUrlToDrivePath,
  isCombNavigable,
  liveUrlToCombPath,
} from "./links";
import { combPath } from "./paths";

const LIVE = "https://live.agent-fs.dev";
const APP = "http://localhost:5274";
const IDS = { orgId: "org-1", driveId: "drive-1" };

function liveTarget(href: string, liveUrl = LIVE) {
  return fileUrlToDrivePath(new URL(href), liveUrl, ["/file/~/", "/detail/~/"]);
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
    expect(liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1/comb-qa/`, LIVE)).toBe(
      "/file/~/org-1/drive-1/comb-qa/",
    );
    expect(liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1/`, LIVE)).toBe("/file/~/org-1/drive-1/");
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
    expect(
      liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1/notes.md?comment=c%201&x=1#top`, LIVE),
    ).toBe("/file/~/org-1/drive-1/notes.md?comment=c%201");
    expect(liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1/notes.md?x=1`, LIVE)).toBe(
      "/file/~/org-1/drive-1/notes.md",
    );
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

  test("decodes each path segment exactly once", () => {
    expect(liveTarget(`${LIVE}/file/~/org-1/drive-1/a%20b.md`)?.path).toBe("/a b.md");
    expect(liveTarget(`${LIVE}/file/~/org-1/drive-1/a b.md`)?.path).toBe("/a b.md");
    // A file literally named "a%20b.md" arrives double-encoded.
    expect(liveTarget(`${LIVE}/file/~/org-1/drive-1/a%2520b.md`)?.path).toBe("/a%20b.md");
    expect(liveTarget(`${LIVE}/file/~/org-1/drive-1/caf%C3%A9/%231.md`)?.path).toBe("/café/#1.md");
  });

  test("hands the decoded path to combPath", () => {
    expect(liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1/a%20b.md`, LIVE)).toBe(
      "/file/~/org-1/drive-1/a%20b.md",
    );
    expect(liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1/a%2520b.md`, LIVE)).toBe(
      combPath({ ...IDS, path: "/a%20b.md" }),
    );
  });

  test("rejects paths that leave the drive", () => {
    for (const path of [
      // Climbs into the drive id slot, or above the route.
      "%2e%2e/secret.md",
      ".%2e/secret.md",
      "%2e%2e/%2e%2e/%2e%2e/x",
      // A decoded "/" or "..": never split into more segments.
      "a%2Fb.md",
      "..%2fsecret.md",
      "%2e%2e%2fsecret.md",
      // Malformed escapes.
      "bad%E0%A4%A.md",
    ]) {
      expect(liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1/${path}`, LIVE)).toBeNull();
    }
    expect(liveUrlToCombPath(`${LIVE}/file/~/org%2F1/drive-1/b.md`, LIVE)).toBeNull();
  });

  test("resolves dot segments inside the drive like a browser", () => {
    expect(liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1/a/../b.md`, LIVE)).toBe(
      "/file/~/org-1/drive-1/b.md",
    );
    expect(liveUrlToCombPath(`${LIVE}/file/~/org-1/drive-1/a/%2E/b.md`, LIVE)).toBe(
      "/file/~/org-1/drive-1/a/b.md",
    );
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

  test("leaves other origins and other routes alone", () => {
    expect(
      appUrlToCombPath("https://app.agent-swarm.dev/file/~/org-1/drive-1/x.md", APP),
    ).toBeNull();
    expect(appUrlToCombPath(`${APP}/detail/~/org-1/drive-1/x.md`, APP)).toBeNull();
    expect(appUrlToCombPath(`${APP}/tasks/123`, APP)).toBeNull();
    expect(appUrlToCombPath("#section", APP)).toBeNull();
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
    for (const state of [
      "disabled",
      "loading",
      "needs-connect",
      "invalid-key",
      "unreachable",
    ] as const) {
      expect(isCombNavigable(state)).toBe(false);
    }
  });
});
