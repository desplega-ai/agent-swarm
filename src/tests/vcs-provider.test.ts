import { describe, expect, test } from "bun:test";
import { detectVcsProvider } from "../vcs";

describe("detectVcsProvider", () => {
  test("detects github.com URLs", () => {
    expect(detectVcsProvider("https://github.com/org/repo")).toBe("github");
  });

  test("detects shorthand org/repo as github", () => {
    expect(detectVcsProvider("org/repo")).toBe("github");
    expect(detectVcsProvider("desplega-ai/agent-swarm")).toBe("github");
  });

  test.each([
    ["https://github.com/acme/gitlab.client", "github"],
    ["git@github.com:acme/gitlab.client.git", "github"],
    ["acme/gitlab.js", "github"],
    ["gitlab.team/widgets", "github"],
    ["https://example.com/acme/gitlab.client", null],
    ["git@example.com:acme/gitlab.client.git", null],
    ["https://gitlab.com@example.com/acme/widgets", null],
    ["https://example.com/acme/widgets?mirror=gitlab.com", null],
    ["https://example.com/acme/widgets#gitlab.com", null],
    ["https://notgitlab.com/acme/widgets", null],
    ["https://code.gitlab.example.com/acme/widgets", null],
  ] as const)("does not classify GitLab text outside the host prefix: %s", (url, expected) => {
    expect(detectVcsProvider(url)).toBe(expected);
  });

  test.each([
    "https://gitlab.com/group/project",
    "https://gitlab.example.com/group/project",
    "https://gitlab.internal/group/project",
    "https://gitlab.example.com:8443/group/project.git",
    "git@gitlab.com:acme/widgets.git",
    "git@gitlab.example.com:group/project.git",
    "ssh://git@gitlab.com/group/project.git",
    "ssh://git@GITLAB.example.com:2222/group/project.git",
  ])("detects GitLab hosts in HTTPS and SSH remotes: %s", (url) => {
    expect(detectVcsProvider(url)).toBe("gitlab");
  });

  test("detects bitbucket.org URLs in https, ssh and .git forms", () => {
    for (const url of [
      "https://bitbucket.org/org/repo",
      "https://bitbucket.org/org/repo.git",
      "https://user@bitbucket.org/org/repo.git",
      "git@bitbucket.org:org/repo.git",
      "ssh://git@bitbucket.org/org/repo.git",
      // A slug containing "github" or "gitlab" must not fall through to those hosts.
      "https://bitbucket.org/org/github-mirror",
      "git@bitbucket.org:gitlab-team/repo.git",
    ]) {
      expect(detectVcsProvider(url)).toBe("bitbucket");
    }
  });

  test("returns null for unrecognised URLs", () => {
    expect(detectVcsProvider("https://example.com")).toBeNull();
    expect(detectVcsProvider("https://notbitbucket.org/org/repo")).toBeNull();
  });
});
