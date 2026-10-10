import { describe, expect, test } from "bun:test";
import { azureDevOpsContextKey, parseContextKey } from "../tasks/context-key";
import {
  canonicalAzureDevOpsRepoUrl,
  isAzureDevOpsUrl,
  parseAzureDevOpsRepoUrl,
} from "../vcs/azure-devops";
import { detectVcsProvider } from "../vcs/index";

describe("Azure Repos URL helpers", () => {
  test("detects Azure DevOps remotes before the GitHub/GitLab heuristics", () => {
    for (const url of [
      "https://dev.azure.com/org/project/_git/repo",
      "https://org@dev.azure.com/org/project/_git/repo",
      "git@ssh.dev.azure.com:v3/org/project/repo",
      "https://fabrikam.visualstudio.com/DefaultCollection/_git/Fabrikam",
      "https://dev.azure.com/github-mirror/project/_git/repo",
    ]) {
      expect(isAzureDevOpsUrl(url)).toBe(true);
      expect(detectVcsProvider(url)).toBe("azure-devops");
    }
    expect(detectVcsProvider("desplega-ai/agent-swarm")).toBe("github");
    expect(detectVcsProvider("https://gitlab.com/group/project")).toBe("gitlab");
    expect(isAzureDevOpsUrl("https://example.com/dev.azure.com.html")).toBe(false);
  });

  test("canonicalizes clone URLs to one https form", () => {
    const canonical = "https://dev.azure.com/org/project/_git/repo";
    expect(canonicalAzureDevOpsRepoUrl("https://org@dev.azure.com/org/project/_git/repo")).toBe(
      canonical,
    );
    expect(canonicalAzureDevOpsRepoUrl("https://dev.azure.com/org/project/_git/repo.git/")).toBe(
      canonical,
    );
    expect(canonicalAzureDevOpsRepoUrl("git@ssh.dev.azure.com:v3/org/project/repo")).toBe(
      canonical,
    );
    // Short form: the project is named like the repo.
    expect(canonicalAzureDevOpsRepoUrl("https://dev.azure.com/tareehd/_git/swarm-test")).toBe(
      "https://dev.azure.com/tareehd/swarm-test/_git/swarm-test",
    );
  });

  test("splits a URL into org, project and repository", () => {
    expect(parseAzureDevOpsRepoUrl("https://org@dev.azure.com/org/My%20Project/_git/repo")).toEqual(
      { orgUrl: "https://dev.azure.com/org", project: "My Project", repository: "repo" },
    );
    expect(parseAzureDevOpsRepoUrl("https://dev.azure.com/tareehd/_git/swarm-test")).toEqual({
      orgUrl: "https://dev.azure.com/tareehd",
      project: "swarm-test",
      repository: "swarm-test",
    });
    expect(
      parseAzureDevOpsRepoUrl("https://fabrikam.visualstudio.com/DefaultCollection/_git/Fabrikam"),
    ).toEqual({
      orgUrl: "https://fabrikam.visualstudio.com/DefaultCollection",
      project: "Fabrikam",
      repository: "Fabrikam",
    });
    expect(parseAzureDevOpsRepoUrl("https://dev.azure.com/org/project")).toBeNull();
  });

  test("context key round-trips", () => {
    const key = azureDevOpsContextKey({ repositoryId: "repo-guid", pullRequestId: 7 });
    expect(key).toBe("task:trackers:azure-devops:repo-guid:pr:7");
    expect(parseContextKey(key)).toEqual({
      family: "trackers",
      subFamily: "azure-devops",
      parts: { repositoryId: "repo-guid", kind: "pr", pullRequestId: 7 },
    });
    expect(() => azureDevOpsContextKey({ repositoryId: "a:b", pullRequestId: 7 })).toThrow();
  });
});
