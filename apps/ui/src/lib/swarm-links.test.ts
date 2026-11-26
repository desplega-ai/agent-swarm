import { describe, expect, test } from "bun:test";
import {
  githubLabel,
  githubTitle,
  linkedUrls,
  normalizeLinkUrl,
  parseGithubShorthand,
  parseSwarmLink,
  parseSwarmLinkOrRef,
  type SwarmLink,
  type SwarmLinkOrigins,
  withoutLinkedUrls,
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
  test.each(["0", "00", "000000000"])("rejects issue number #%s", (number) => {
    const raw = `desplega-ai/agent-swarm#${number}`;
    expect(parseGithubShorthand(raw)).toBeNull();
    expect(parseSwarmLinkOrRef(raw, ORIGINS)).toBeNull();
  });

  test.each(["1", "001", "999999999"])("accepts positive issue number #%s", (number) => {
    const raw = `desplega-ai/agent-swarm#${number}`;
    const expected = {
      type: "github",
      kind: "ref",
      owner: "desplega-ai",
      repo: "agent-swarm",
      number: Number(number),
      sha: null,
      href: `https://github.com/desplega-ai/agent-swarm/issues/${number}`,
    };
    expect(parseGithubShorthand(raw)).toEqual(expected);
    expect(parseSwarmLinkOrRef(raw, ORIGINS)).toEqual(expected);
  });

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

  test("anything else is not shorthand", () => {
    expect(parseGithubShorthand("agent-swarm#2605")).toBeNull();
    expect(parseGithubShorthand("o/r#")).toBeNull();
    expect(parseGithubShorthand("o/r#12 fixes")).toBeNull();
    expect(parseGithubShorthand("a/b/c#1")).toBeNull();
    expect(parseGithubShorthand("o/r@abc")).toBeNull();
    expect(parseGithubShorthand("orgs/r#1")).toBeNull();
    expect(parseGithubShorthand("https://github.com/o/r/pull/1")).toBeNull();
  });

  test("a dot-only owner or repo is not a GitHub reference", () => {
    for (const text of ["./repo#1", "../repo#1", "o/..#1", "./repo@a1b2c3d"]) {
      expect(parseGithubShorthand(text)).toBeNull();
    }
  });

  test("an owner with dots in it is still a link", () => {
    expect(parseGithubShorthand("my.org/repo#1")).toMatchObject({ owner: "my.org", repo: "repo" });
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

describe("parseSwarmLink: GitLab, Linear, Jira and Slack", () => {
  const ext = (href: string) => {
    const link = parse(href);
    return link?.type === "external"
      ? { provider: link.provider, kind: link.kind, label: link.label, title: link.title }
      : link;
  };
  test("a GitLab MR, issue and commit on any host", () => {
    expect(ext("https://gitlab.com/group/sub/app/-/merge_requests/42")).toEqual({
      provider: "gitlab",
      kind: "mr",
      label: "app!42",
      title: "MR group/sub/app!42",
    });
    expect(ext("https://git.corp.example/team/app/-/issues/7#note_1")).toMatchObject({
      kind: "issue",
      label: "app#7",
    });
    expect(ext("https://gitlab.com/g/app/-/commit/ABCDEF1234567")).toMatchObject({
      kind: "commit",
      label: "app@abcdef1",
    });
  });
  test("Linear and Jira issue keys", () => {
    expect(ext("https://linear.app/desplega/issue/des-375/expose-tool")).toMatchObject({
      provider: "linear",
      label: "DES-375",
    });
    expect(ext("https://acme.atlassian.net/browse/OPS-12")).toMatchObject({
      provider: "jira",
      label: "OPS-12",
    });
    expect(
      ext("https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=OPS-9"),
    ).toMatchObject({ provider: "jira", label: "OPS-9" });
  });
  test("a Slack message and a thread reply", () => {
    expect(ext("https://acme.slack.com/archives/C0123ABC/p1764150000123456")).toMatchObject({
      provider: "slack",
      kind: "message",
      label: "Slack message",
    });
    expect(
      ext("https://acme.slack.com/archives/C0123ABC/p1764150000123456?thread_ts=1764150000.000100"),
    ).toMatchObject({ kind: "thread", label: "Slack thread" });
  });
  test("other pages of those hosts stay plain links (negative controls)", () => {
    for (const href of [
      "https://gitlab.com/group/app/-/merge_requests/new",
      "https://gitlab.com/group/app",
      "https://linear.app/desplega/projects",
      "https://acme.atlassian.net/wiki/spaces/ENG",
      "https://acme.slack.com/archives/C0123ABC",
      "https://example.com/-/issues/12x",
      "https://example.com/some/page",
    ]) {
      expect(parse(href)).toBeNull();
    }
  });
});

describe("link dedupe", () => {
  test("normalizeLinkUrl drops www, trailing slash, query and fragment", () => {
    const want = "github.com/desplega-ai/agent-swarm/pull/3705";
    for (const href of [
      "https://github.com/desplega-ai/agent-swarm/pull/3705",
      "https://www.GitHub.com/desplega-ai/agent-swarm/pull/3705/",
      "http://github.com/desplega-ai/agent-swarm/pull/3705?notification_referrer_id=x#issuecomment-1",
    ]) {
      expect(normalizeLinkUrl(href)).toBe(want);
    }
    expect(normalizeLinkUrl("not a url")).toBeNull();
    expect(normalizeLinkUrl("mailto:a@b.c")).toBeNull();
  });

  test("linkedUrls finds bare, markdown and Slack links and trims trailing punctuation", () => {
    const text = [
      "See [#3705](https://github.com/o/r/pull/3705).",
      "Also https://example.com/a/, and <https://acme.slack.com/archives/C1/p1764150000123456|thread>.",
      "Bold **https://linear.app/x/issue/ENG-1**",
    ].join("\n");
    expect([...linkedUrls(text)].sort()).toEqual([
      "acme.slack.com/archives/C1/p1764150000123456",
      "example.com/a",
      "github.com/o/r/pull/3705",
      "linear.app/x/issue/ENG-1",
    ]);
    expect(linkedUrls(null).size).toBe(0);
  });

  test("withoutLinkedUrls drops a link attachment the text names, keeps files and other links", () => {
    const rows = [
      { id: "pr", kind: "url", url: "https://github.com/o/r/pull/3705/" },
      { id: "other", kind: "url", url: "https://github.com/o/r/pull/9" },
      { id: "file", kind: "agent-fs", url: null },
    ];
    const text = "Merged [#3705](https://github.com/o/r/pull/3705#discussion).";
    expect(withoutLinkedUrls(rows, text).map((r) => r.id)).toEqual(["other", "file"]);
    expect(withoutLinkedUrls(rows, undefined)).toBe(rows);
  });
});
