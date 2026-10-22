import { describe, expect, test } from "bun:test";
import { bitbucketFullName, isBitbucketUrl, parseBitbucketRepoUrl } from "../vcs/bitbucket";
import { detectVcsProvider } from "../vcs/index";

describe("Bitbucket Cloud URL helpers", () => {
  test("isBitbucketUrl accepts bitbucket.org remotes only", () => {
    for (const url of [
      "https://bitbucket.org/ws/repo",
      "https://BitBucket.org/ws/repo",
      "https://x-token-auth@bitbucket.org/ws/repo.git",
      "git@bitbucket.org:ws/repo.git",
      "ssh://git@bitbucket.org/ws/repo.git",
    ]) {
      expect(isBitbucketUrl(url)).toBe(true);
    }
    for (const url of [
      "https://github.com/ws/repo",
      "https://notbitbucket.org/ws/repo",
      "https://bitbucket.org.evil.com/ws/repo",
      "https://example.com/bitbucket.org.html",
      "https://gitlab.com/bitbucket.org/repo.git",
      "git@gitlab.com:bitbucket.org/repo.git",
      "https://github.com/acme/bitbucket.org",
      "ws/repo",
    ]) {
      expect(isBitbucketUrl(url)).toBe(false);
    }
  });

  test("parses https remotes with and without user@ and .git", () => {
    const expected = { workspace: "my-ws", repoSlug: "my-repo" };
    for (const url of [
      "https://bitbucket.org/my-ws/my-repo",
      "https://bitbucket.org/my-ws/my-repo/",
      "https://bitbucket.org/my-ws/my-repo.git",
      "https://alice@bitbucket.org/my-ws/my-repo.git",
      "https://x-token-auth:tok@bitbucket.org/my-ws/my-repo.git",
      "  https://bitbucket.org/my-ws/my-repo.git  ",
      "https://bitbucket.org/my-ws/my-repo/pull-requests/7",
    ]) {
      expect(parseBitbucketRepoUrl(url)).toEqual(expected);
    }
  });

  test("parses ssh remotes", () => {
    expect(parseBitbucketRepoUrl("git@bitbucket.org:my-ws/my-repo.git")).toEqual({
      workspace: "my-ws",
      repoSlug: "my-repo",
    });
    expect(parseBitbucketRepoUrl("git@bitbucket.org:my-ws/my-repo")).toEqual({
      workspace: "my-ws",
      repoSlug: "my-repo",
    });
    expect(parseBitbucketRepoUrl("ssh://git@bitbucket.org/my-ws/my-repo.git")).toEqual({
      workspace: "my-ws",
      repoSlug: "my-repo",
    });
  });

  test("keeps dots inside repository slugs", () => {
    expect(parseBitbucketRepoUrl("https://bitbucket.org/ws/my.site.git")).toEqual({
      workspace: "ws",
      repoSlug: "my.site",
    });
    expect(bitbucketFullName("git@bitbucket.org:ws/my.site.git")).toBe("ws/my.site");
  });

  test("returns null for non-Bitbucket or incomplete URLs", () => {
    expect(parseBitbucketRepoUrl("https://github.com/ws/repo")).toBeNull();
    expect(parseBitbucketRepoUrl("https://bitbucket.org/ws")).toBeNull();
    expect(parseBitbucketRepoUrl("https://bitbucket.org/")).toBeNull();
    expect(parseBitbucketRepoUrl("git@bitbucket.org:ws.git")).toBeNull();
    expect(parseBitbucketRepoUrl("not a url bitbucket.org")).toBeNull();
    expect(bitbucketFullName("https://gitlab.com/group/project")).toBeNull();
  });

  test("bitbucketFullName yields workspace/repo_slug", () => {
    expect(bitbucketFullName("https://bitbucket.org/ws/repo.git")).toBe("ws/repo");
    expect(bitbucketFullName("git@bitbucket.org:ws/repo.git")).toBe("ws/repo");
  });

  test("detectVcsProvider checks Bitbucket before the GitHub owner/repo fallback", () => {
    expect(detectVcsProvider("https://bitbucket.org/ws/repo")).toBe("bitbucket");
    expect(detectVcsProvider("ws/repo")).toBe("github");
  });

  test("a bitbucket.org path segment on another host keeps that host's provider", () => {
    expect(detectVcsProvider("https://gitlab.com/bitbucket.org/repo.git")).toBe("gitlab");
    expect(parseBitbucketRepoUrl("https://gitlab.com/bitbucket.org/repo.git")).toBeNull();
  });
});
