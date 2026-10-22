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

  test("detects gitlab.com URLs", () => {
    expect(detectVcsProvider("https://gitlab.com/group/project")).toBe("gitlab");
  });

  test("detects self-hosted gitlab URLs", () => {
    expect(detectVcsProvider("https://gitlab.mycompany.com/group/project")).toBe("gitlab");
    expect(detectVcsProvider("https://gitlab.internal/group/project")).toBe("gitlab");
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
