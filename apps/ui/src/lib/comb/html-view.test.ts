import { describe, expect, test } from "bun:test";
import {
  HTML_FRAME_POLICY,
  HTML_SANDBOX,
  HTML_SITE_REMINT_MS,
  HTML_SITE_TTL_SECONDS,
  isDriveRootFile,
  isHtmlPath,
  siteBaseUrl,
  siteFileUrl,
  siteFolderOf,
  siteShareFreshFor,
} from "./html-view";

describe("the preview frame sandbox", () => {
  const tokens = HTML_SANDBOX.split(/\s+/);

  test("lets the page run scripts, forms, popups, and dialogs", () => {
    expect(tokens).toEqual(["allow-scripts", "allow-forms", "allow-popups", "allow-modals"]);
  });

  test("never gives the page an origin, the top window, unsandboxed popups, or downloads", () => {
    expect(tokens).not.toContain("allow-same-origin");
    expect(tokens).not.toContain("allow-popups-to-escape-sandbox");
    expect(tokens.filter((token) => token.startsWith("allow-top-navigation"))).toEqual([]);
    expect(tokens).not.toContain("allow-downloads");
    expect(tokens).not.toContain("allow-storage-access-by-user-activation");
  });

  test("the frame sends no referrer and uses this sandbox", () => {
    expect(HTML_FRAME_POLICY).toEqual({ sandbox: HTML_SANDBOX, referrerPolicy: "no-referrer" });
  });
});

describe("site paths", () => {
  test("isHtmlPath matches .html and .htm in any case", () => {
    expect(isHtmlPath("/site/page.html")).toBe(true);
    expect(isHtmlPath("/site/PAGE.HTM")).toBe(true);
    expect(isHtmlPath("/site/page.html.txt")).toBe(false);
    expect(isHtmlPath("/site/html")).toBe(false);
  });

  test("siteFolderOf and isDriveRootFile", () => {
    expect(siteFolderOf("/site/page.html")).toBe("/site");
    expect(siteFolderOf("/a/b/page.html")).toBe("/a/b");
    expect(siteFolderOf("/page.html")).toBe("/");
    expect(isDriveRootFile("/page.html")).toBe(true);
    expect(isDriveRootFile("/site/page.html")).toBe(false);
  });

  test("the frame URL uses the browser's agent-fs URL and encodes the name", () => {
    const base = siteBaseUrl("https://fs.example.com/", "/site/tok");
    expect(base).toBe("https://fs.example.com/site/tok/");
    expect(siteBaseUrl("https://ui.example.com/fs", "/site/tok/")).toBe(
      "https://ui.example.com/fs/site/tok/",
    );
    expect(siteFileUrl(base, "/site/page.html")).toBe("https://fs.example.com/site/tok/page.html");
    expect(siteFileUrl(base, "/site/my report #2?.html")).toBe(
      "https://fs.example.com/site/tok/my%20report%20%232%3F.html",
    );
  });
});

describe("site share lifetime", () => {
  test("a preview share lives 15 minutes", () => {
    expect(HTML_SITE_TTL_SECONDS).toBe(900);
  });

  test("a share is replaced 3 minutes before it expires", () => {
    const expiresAt = 1_000_000_000;
    expect(siteShareFreshFor(expiresAt, expiresAt - HTML_SITE_REMINT_MS - 1)).toBe(1);
    expect(siteShareFreshFor(expiresAt, expiresAt - HTML_SITE_REMINT_MS)).toBe(0);
    expect(siteShareFreshFor(expiresAt, expiresAt + 5)).toBe(0);
  });
});
