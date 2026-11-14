import { describe, expect, test } from "bun:test";
import {
  githubLabel,
  githubTitle,
  parseGithubShorthand,
  parseSwarmLink,
  parseSwarmLinkOrRef,
  type SwarmLink,
  type SwarmLinkOrigins,
} from "./swarm-links";

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

type GithubLink = Extract<SwarmLink, { type: "github" }>;
const github = (href: string) => parse(href) as GithubLink;

describe("parseSwarmLink: github", () => {
  test("a PR, with and without a sub-page or a hash", () => {
    expect(github("https://github.com/desplega-ai/agent-swarm/pull/2605")).toEqual({
      type: "github",
      kind: "pull",
      owner: "desplega-ai",
      repo: "agent-swarm",
      number: 2605,
      sha: null,
      href: "https://github.com/desplega-ai/agent-swarm/pull/2605",
    });
    expect(github("https://github.com/o/r/pull/7/files#diff-1")).toMatchObject({
      kind: "pull",
      number: 7,
    });
    expect(github("https://github.com/o/r/pull/7#pullrequestreview-9").href).toBe(
      "https://github.com/o/r/pull/7#pullrequestreview-9",
    );
  });

  test("an issue, a commit and a repo", () => {
    expect(github("https://github.com/o/r/issues/12")).toMatchObject({ kind: "issue", number: 12 });
    expect(github("https://github.com/o/r/commit/A1B2C3D4E5F6")).toMatchObject({
      kind: "commit",
      sha: "a1b2c3d4e5f6",
    });
    expect(github("https://github.com/o/r")).toMatchObject({ kind: "repo", owner: "o", repo: "r" });
    expect(github("https://www.github.com/o/r/")).toMatchObject({ kind: "repo" });
  });

  test("issue and PR number zero is rejected", () => {
    expect(parse("https://github.com/o/r/issues/0")).toBeNull();
    expect(parse("https://github.com/o/r/pull/0")).toBeNull();
  });

  test("other github.com pages and hosts are plain links", () => {
    expect(parse("https://github.com/o/r/tree/main/src")).toBeNull();
    expect(parse("https://github.com/o/r/pull/abc")).toBeNull();
    expect(parse("https://github.com/o/r/commit/xyz")).toBeNull();
    expect(parse("https://github.com/o")).toBeNull();
    expect(parse("https://github.com/orgs/desplega-ai")).toBeNull();
    expect(parse("https://github.com/settings/profile")).toBeNull();
    expect(parse("https://gist.github.com/o/r/pull/1")).toBeNull();
    expect(parse("https://github.com.evil.example/o/r/pull/1")).toBeNull();
    expect(parse("https://example.com/o/r/pull/1")).toBeNull();
  });

  test("labels and hover titles", () => {
    expect(githubLabel(github("https://github.com/desplega-ai/agent-swarm/pull/2605"))).toBe(
      "agent-swarm#2605",
    );
    expect(githubLabel(github("https://github.com/o/r/issues/3"))).toBe("r#3");
    expect(githubLabel(github("https://github.com/o/r/commit/a1b2c3d4e5f6"))).toBe("r@a1b2c3d");
    expect(githubLabel(github("https://github.com/o/r"))).toBe("o/r");
    expect(githubTitle(github("https://github.com/o/r/pull/3"))).toBe("PR o/r#3");
    expect(githubTitle(github("https://github.com/o/r/issues/3"))).toBe("Issue o/r#3");
    expect(githubTitle(github("https://github.com/o/r/commit/a1b2c3d4e5f6"))).toBe(
      "o/r@a1b2c3d4e5f6",
    );
  });
});

describe("parseGithubShorthand", () => {
  test("owner/repo#N is a ref to the issues URL, which GitHub redirects for a PR", () => {
    expect(parseGithubShorthand("desplega-ai/agent-swarm#2605")).toMatchObject({
      type: "github",
      kind: "ref",
      number: 2605,
      href: "https://github.com/desplega-ai/agent-swarm/issues/2605",
    });
    expect(githubLabel(parseGithubShorthand(" o/r#4 ") as GithubLink)).toBe("r#4");
  });

  test("owner/repo@sha is a commit", () => {
    expect(parseGithubShorthand("o/r@A1B2C3D")).toMatchObject({
      kind: "commit",
      sha: "a1b2c3d",
      href: "https://github.com/o/r/commit/a1b2c3d",
    });
  });

  test("issue number zero is rejected", () => {
    expect(parseGithubShorthand("o/r#0")).toBeNull();
  });

  test("anything else is not shorthand", () => {
    expect(parseGithubShorthand("agent-swarm#2605")).toBeNull();
    expect(parseGithubShorthand("o/r#")).toBeNull();
    expect(parseGithubShorthand("o/r#12 fixes")).toBeNull();
    expect(parseGithubShorthand("a/b/c#1")).toBeNull();
    expect(parseGithubShorthand("o/r@abc")).toBeNull();
    expect(parseGithubShorthand("orgs/r#1")).toBeNull();
    expect(parseGithubShorthand("https://github.com/o/r/pull/1")).toBeNull();
  });

  test("parseSwarmLinkOrRef takes shorthand, then URLs", () => {
    expect(parseSwarmLinkOrRef("o/r#1", ORIGINS)).toMatchObject({ type: "github" });
    expect(parseSwarmLinkOrRef(`/tasks/${TASK_ID}`, ORIGINS)).toMatchObject({ type: "dashboard" });
    expect(parseSwarmLinkOrRef("hello", ORIGINS)).toBeNull();
  });
});

describe("GitHub Enterprise Server web base", () => {
  const GHES: SwarmLinkOrigins = { ...ORIGINS, github: "https://ghe.test" };

  test("a PR on the configured host is a PR chip", () => {
    expect(parse("https://ghe.test/o/r/pull/7", GHES)).toEqual({
      type: "github",
      kind: "pull",
      owner: "o",
      repo: "r",
      number: 7,
      sha: null,
      href: "https://ghe.test/o/r/pull/7",
    });
  });

  test("shorthand links to the configured host", () => {
    expect(parseSwarmLinkOrRef("o/r#7", GHES)).toMatchObject({
      kind: "ref",
      href: "https://ghe.test/o/r/issues/7",
    });
    expect(parseGithubShorthand("o/r@a1b2c3d", "https://ghe.test")).toMatchObject({
      href: "https://ghe.test/o/r/commit/a1b2c3d",
    });
  });

  test("only the configured host matches: github.com and other hosts stay plain links", () => {
    expect(parse("https://github.com/o/r/pull/7", GHES)).toBeNull();
    expect(parse("https://www.github.com/o/r/pull/7", GHES)).toBeNull();
    expect(parse("https://ghe.test:8443/o/r/pull/7", GHES)).toBeNull();
  });

  test("a port in the web base is part of the host", () => {
    const withPort = { ...ORIGINS, github: "https://ghe.test:8443" };
    expect(parse("https://ghe.test:8443/o/r/pull/7", withPort)).toMatchObject({ kind: "pull" });
    expect(parse("https://ghe.test/o/r/pull/7", withPort)).toBeNull();
  });

  test("in default mode ghe.test URLs are plain links", () => {
    expect(parse("https://ghe.test/o/r/pull/7")).toBeNull();
    expect(parse("https://ghe.test/o/r/pull/7", { ...ORIGINS, github: null })).toBeNull();
    expect(parseSwarmLinkOrRef("o/r#7", ORIGINS)).toMatchObject({
      href: "https://github.com/o/r/issues/7",
    });
  });
});
