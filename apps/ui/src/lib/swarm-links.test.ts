import { describe, expect, test } from "bun:test";
import { parseSwarmLink, type SwarmLinkOrigins } from "./swarm-links";

const ORIGINS: SwarmLinkOrigins = {
  dashboard: "https://swarm.example.com",
  configuredDashboard: "https://dash.example.com",
  agentFsLive: "https://fs.example.com",
  agentFsApi: "https://fs-api.example.com/agent-fs",
};
const PAGE_ID = "cfd9bc4bc838487ea7cde4708dfb4dc1";
const TASK_ID = "8dcee854-1f0a-4c55-9a43-2b3c7e9d0f11";
const FILE = "https://fs.example.com/file/~/org-1/drive-1";

const parse = (href: string, origins: SwarmLinkOrigins = ORIGINS) => parseSwarmLink(href, origins);

describe("parseSwarmLink: dashboard", () => {
  test("a route with an id on the dashboard origin", () => {
    expect(parse(`https://swarm.example.com/pages/${PAGE_ID}`)).toEqual({
      type: "dashboard",
      route: "pages",
      id: PAGE_ID,
      path: `/pages/${PAGE_ID}`,
      href: `https://swarm.example.com/pages/${PAGE_ID}`,
    });
  });

  test("keeps the query and the hash in the router path", () => {
    expect(parse(`https://swarm.example.com/pages/${PAGE_ID}?mode=full#top`)).toMatchObject({
      path: `/pages/${PAGE_ID}?mode=full#top`,
    });
  });

  test("the configured dashboard: the same path on this dashboard", () => {
    expect(parse(`https://dash.example.com/pages/${PAGE_ID}?mode=full`)).toMatchObject({
      route: "pages",
      id: PAGE_ID,
      path: `/pages/${PAGE_ID}?mode=full`,
    });
    expect(parse("https://dash.example.com/file/~/org-1/drive-1/a.md")).toMatchObject({
      type: "file",
      name: "a.md",
    });
    expect(
      parse(`https://dash.example.com/pages/${PAGE_ID}`, { ...ORIGINS, configuredDashboard: null }),
    ).toBeNull();
  });

  test("a root-relative link and a sub-route", () => {
    expect(parse(`/tasks/${TASK_ID}`)).toMatchObject({ route: "tasks", id: TASK_ID });
    expect(parse(`https://swarm.example.com/tasks/${TASK_ID}/lineage`)).toMatchObject({
      route: "tasks",
      path: `/tasks/${TASK_ID}/lineage`,
    });
  });

  test("a slug id stays whole", () => {
    expect(parse("https://swarm.example.com/pages/helmcode-benchmark")).toMatchObject({
      id: "helmcode-benchmark",
    });
  });

  test("other hosts, unknown routes, and lists are plain links", () => {
    expect(parse(`https://other.example.com/pages/${PAGE_ID}`)).toBeNull();
    expect(parse("https://swarm.example.com/settings/general")).toBeNull();
    expect(parse("https://swarm.example.com/tasks")).toBeNull();
    expect(parse("https://swarm.example.com/workflows/new")).toBeNull();
    expect(parse(`//swarm.example.com/pages/${PAGE_ID}`)).toBeNull();
    expect(parse("mailto:someone@example.com")).toBeNull();
    expect(parse("javascript:alert(1)")).toBeNull();
  });
});

describe("parseSwarmLink: agent-fs", () => {
  test("a live UI file: the decoded name and path", () => {
    expect(parse(`${FILE}/research/My%20notes.md`)).toEqual({
      type: "file",
      name: "My notes.md",
      path: "/research/My notes.md",
      folder: false,
      href: `${FILE}/research/My%20notes.md`,
    });
  });

  test("a folder link ends with a slash", () => {
    expect(parse(`${FILE}/qa/page-v3/`)).toMatchObject({
      name: "page-v3",
      path: "/qa/page-v3/",
      folder: true,
    });
  });

  test("the dashboard's own file route", () => {
    expect(parse("https://swarm.example.com/file/~/org-1/drive-1/docs/a.md")).toMatchObject({
      type: "file",
      name: "a.md",
    });
  });

  test("a Slack-style label after | ends the URL", () => {
    expect(parse(`${FILE}/docs/today.md|today.md`)).toMatchObject({
      name: "today.md",
      href: `${FILE}/docs/today.md`,
    });
  });

  test("dot segments and the drive root are plain links", () => {
    expect(parse(`${FILE}/docs/../../other/x.md`)).toBeNull();
    expect(parse(`${FILE}/%2e%2e/x.md`)).toBeNull();
    expect(parse(`${FILE}/`)).toBeNull();
  });

  test("share links on a configured agent-fs origin", () => {
    expect(parse("https://fs-api.example.com/agent-fs/share/AbC123")).toEqual({
      type: "share",
      name: null,
      href: "https://fs-api.example.com/agent-fs/share/AbC123",
    });
    expect(parse("https://fs.example.com/share/AbC123?name=report.pdf")).toMatchObject({
      type: "share",
      name: "report.pdf",
    });
    expect(parse("https://fs.example.com/share/AbC123/plan%20v2.md")).toMatchObject({
      name: "plan v2.md",
    });
  });

  test("agent-fs links on hosts nobody configured are plain links", () => {
    expect(parse("https://elsewhere.example.com/share/AbC123")).toBeNull();
    expect(parse("https://elsewhere.example.com/file/~/org-1/drive-1/a.md")).toBeNull();
    const none = { ...ORIGINS, agentFsLive: null, agentFsApi: null };
    expect(parse(`${FILE}/a.md`, none)).toBeNull();
    expect(parse("https://fs-api.example.com/share/AbC123", none)).toBeNull();
  });
});
