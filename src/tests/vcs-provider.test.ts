import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { detectVcsForTask } from "../commands/runner";
import { detectVcsProvider } from "../vcs";

const originalGitLabUrl = process.env.GITLAB_URL;

beforeEach(() => {
  delete process.env.GITLAB_URL;
});

afterEach(() => {
  if (originalGitLabUrl === undefined) delete process.env.GITLAB_URL;
  else process.env.GITLAB_URL = originalGitLabUrl;
});

describe("detectVcsProvider", () => {
  test("detects github.com URLs", () => {
    expect(detectVcsProvider("https://github.com/org/repo")).toBe("github");
    expect(detectVcsProvider("git@github.com:org/repo.git")).toBe("github");
    expect(detectVcsProvider("https://www.github.com/org/repo")).toBe("github");
    // A `dev.azure.com` path segment on a GitHub URL is still a GitHub URL.
    expect(detectVcsProvider("https://github.com/acme/dev.azure.com/tree/main")).toBe("github");
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

  test.each([
    ["https://code.acme.io/group/project", "gitlab"],
    ["ssh://git@CODE.acme.io:2222/group/project.git", "gitlab"],
    ["git@Code.Acme.io:group/project.git", "gitlab"],
    ["https://code.acme.io.example.com/group/project", null],
    ["https://gitlab.acme.io/group/project", "gitlab"],
  ] as const)("compares the configured GitLab hostname against %s", (url, expected) => {
    process.env.GITLAB_URL = "https://CODE.acme.io:8443/gitlab/";
    expect(detectVcsProvider(url)).toBe(expected);
  });

  test("keeps github.com recognized with the default GitLab URL configured", () => {
    process.env.GITLAB_URL = "https://gitlab.com";
    expect(detectVcsProvider("https://github.com/org/repo")).toBe("github");
  });

  test("ignores a malformed GitLab URL", () => {
    process.env.GITLAB_URL = "https://[";
    expect(detectVcsProvider("https://gitlab.acme.io/group/project")).toBe("gitlab");
    expect(detectVcsProvider("https://code.acme.io/group/project")).toBeNull();
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
    // A `github.com` path segment on another host keeps that host's provider.
    expect(detectVcsProvider("https://gitea.example.com/mirrors/github.com/acme/repo")).toBeNull();
    expect(detectVcsProvider("https://notgithub.com/acme/repo")).toBeNull();
    expect(detectVcsProvider("https://code.example.com/acme/repo")).toBeNull();
  });
});

/**
 * A throwaway repo whose `origin` is remoteUrl and whose current branch is `feat`,
 * plus `gh` and `glab` stubs that append the command they were handed to a log and
 * print an empty list. The stubs are shell scripts on PATH, as in
 * src/tests/acp-adapter.test.ts; this file's CLI cases skip on Windows, where bun
 * resolves an installed gh.exe ahead of a .cmd stub whatever the PATH order.
 */
function repoWithVcsStubs(remoteUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "vcs-provider-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  for (const tool of ["gh", "glab"]) {
    const path = join(bin, tool);
    writeFileSync(path, `#!/bin/sh\necho "${tool} $*" >> "${log}"\necho "[]"\n`);
    chmodSync(path, 0o755);
  }
  const git = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", "-C", dir, ...args]);
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    }
  };
  git("init", "-q");
  git("remote", "add", "origin", remoteUrl);
  git("-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "--allow-empty", "-m", "init");
  git("checkout", "-q", "-b", "feat");
  return { dir, bin, log };
}

// A remote's path can name the other host: a GitLab mirror called github-sync, or a
// GitHub repo called gitlab-tools. Routing has to follow the host, not the substring.
describe.skipIf(process.platform === "win32")("detectVcsForTask", () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  test.each([
    ["gitlab.com/acme/github-sync", "https://gitlab.com/acme/github-sync.git", "glab mr list"],
    ["github.com/acme/gitlab-tools", "https://github.com/acme/gitlab-tools.git", "gh pr list"],
  ])("routes %s to the CLI of its host", async (_name, remoteUrl, expectedCall) => {
    const otherCall = expectedCall.startsWith("glab") ? "gh pr list" : "glab mr list";
    const { dir, bin, log } = repoWithVcsStubs(remoteUrl);
    try {
      process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
      await detectVcsForTask("http://127.0.0.1:1", "", "task-1", dir);
      const calls = readFileSync(log, "utf8");
      expect(calls).toContain(expectedCall);
      expect(calls).not.toContain(otherCall);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
