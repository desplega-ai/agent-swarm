import { describe, expect, test } from "bun:test";
import { isPlainClick, linkPreviewTarget } from "./link-preview";
import type { SwarmLinkOrigins } from "./swarm-links";

const ORIGINS: SwarmLinkOrigins = {
  dashboard: "https://swarm.example.com",
  configuredDashboard: "https://dash.example.com",
  agentFsLive: "https://fs.example.com",
  agentFsApi: "https://fs-api.example.com/agent-fs",
};
const PAGE_ID = "cfd9bc4bc838487ea7cde4708dfb4dc1";

const target = (href: string) => linkPreviewTarget(href, ORIGINS);

describe("linkPreviewTarget", () => {
  test("an agent-fs live link previews the drive file", () => {
    const href = "https://fs.example.com/file/~/org-1/drive-1/docs/My%20notes.md";
    expect(target(href)).toEqual({
      kind: "file",
      file: { orgId: "org-1", driveId: "drive-1", path: "/docs/My notes.md" },
      name: "My notes.md",
      route: "/file/~/org-1/drive-1/docs/My%20notes.md",
      href,
    });
  });

  test("a dashboard file link, relative or on the configured dashboard", () => {
    expect(target("/file/~/org-1/drive-1/a.md")).toMatchObject({
      kind: "file",
      file: { orgId: "org-1", driveId: "drive-1", path: "/a.md" },
    });
    expect(target("https://dash.example.com/file/~/org-1/drive-1/a.md?comment=c1")).toMatchObject({
      kind: "file",
      route: "/file/~/org-1/drive-1/a.md",
    });
  });

  test("a page link by id or slug", () => {
    expect(target(`https://swarm.example.com/pages/${PAGE_ID}`)).toEqual({
      kind: "page",
      id: PAGE_ID,
      href: `https://swarm.example.com/pages/${PAGE_ID}`,
    });
    expect(target("/pages/weekly-report")).toMatchObject({ kind: "page", id: "weekly-report" });
  });

  test("folders, other routes, GitHub and unknown links keep their behavior", () => {
    expect(target("https://fs.example.com/file/~/org-1/drive-1/docs/")).toBeNull();
    expect(target("/tasks/8dcee854-1f0a-4c55-9a43-2b3c7e9d0f11")).toBeNull();
    expect(target("https://github.com/desplega-ai/agent-swarm/pull/1")).toBeNull();
    expect(target("https://example.org/file/~/org-1/drive-1/a.md")).toBeNull();
    expect(target("https://fs.example.com/file/~/org-1/drive-1/%2e%2e/x.md")).toBeNull();
    expect(target(null)).toBeNull();
  });
});

describe("isPlainClick", () => {
  const click = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };

  test("a primary click with no modifier", () => {
    expect(isPlainClick(click)).toBe(true);
  });

  test("modifier, middle and handled clicks keep the link behavior", () => {
    expect(isPlainClick({ ...click, metaKey: true })).toBe(false);
    expect(isPlainClick({ ...click, ctrlKey: true })).toBe(false);
    expect(isPlainClick({ ...click, shiftKey: true })).toBe(false);
    expect(isPlainClick({ ...click, altKey: true })).toBe(false);
    expect(isPlainClick({ ...click, button: 1 })).toBe(false);
    expect(isPlainClick({ ...click, defaultPrevented: true })).toBe(false);
  });
});
