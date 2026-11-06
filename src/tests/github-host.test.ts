/**
 * GitHub host resolver (src/utils/github-host.ts) and the parsers, presets and
 * bindings that read it. Default mode must stay byte-identical to github.com;
 * GHES mode must target only the configured host.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { githubCitationUrl } from "../be/task-citations";
import { getOAuthPreset, listOAuthPresets } from "../oauth/presets";
import { normalizeRepoUrl } from "../providers/claude-managed-adapter";
import { defaultCredentialBindings } from "../scripts-runtime/credential-broker";
import {
  getGitHubHostForSql,
  githubApiUrl,
  githubWebLink,
  isGitHubUrl,
  resolveGitHubHost,
} from "../utils/github-host";
import { extractGitHubPullRequestUrls } from "../utils/github-pull-request";
import { detectVcsProvider } from "../vcs";

const saved = { url: process.env.GITHUB_URL, api: process.env.GITHUB_API_URL };

beforeEach(() => {
  delete process.env.GITHUB_URL;
  delete process.env.GITHUB_API_URL;
});

afterEach(() => {
  for (const [key, value] of [
    ["GITHUB_URL", saved.url],
    ["GITHUB_API_URL", saved.api],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function resolved(env: Record<string, string>) {
  const result = resolveGitHubHost(env);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("resolveGitHubHost: derivation table", () => {
  test("nothing set = github.com", () => {
    expect(resolved({}).config).toEqual({
      webUrl: "https://github.com",
      apiUrl: "https://api.github.com",
      graphqlUrl: "https://api.github.com/graphql",
      host: "github.com",
      apiHost: "api.github.com",
      enterprise: false,
    });
  });

  test("explicit github.com, www. or empty is the default", () => {
    const def = resolved({}).config;
    for (const url of ["https://github.com", "https://github.com/", "https://www.github.com", ""]) {
      expect(resolved({ GITHUB_URL: url }).config).toEqual(def);
    }
  });

  test("GHES: /api/v3 and /api/graphql on the instance", () => {
    expect(resolved({ GITHUB_URL: "https://ghe.corp" }).config).toEqual({
      webUrl: "https://ghe.corp",
      apiUrl: "https://ghe.corp/api/v3",
      graphqlUrl: "https://ghe.corp/api/graphql",
      host: "ghe.corp",
      apiHost: "ghe.corp",
      enterprise: true,
    });
  });

  test("GHE.com data residency: api. subdomain", () => {
    const { config } = resolved({ GITHUB_URL: "https://acme.ghe.com" });
    expect(config.apiUrl).toBe("https://api.acme.ghe.com");
    expect(config.graphqlUrl).toBe("https://api.acme.ghe.com/graphql");
    expect(config.host).toBe("acme.ghe.com");
  });

  test("GITHUB_API_URL overrides REST and derives GraphQL", () => {
    const v3 = resolved({
      GITHUB_URL: "https://ghe.corp",
      GITHUB_API_URL: "https://api.ghe.corp/api/v3/",
    });
    expect(v3.config.apiUrl).toBe("https://api.ghe.corp/api/v3");
    expect(v3.config.graphqlUrl).toBe("https://api.ghe.corp/api/graphql");
    expect(v3.config.webUrl).toBe("https://ghe.corp");
    const other = resolved({ GITHUB_API_URL: "https://proxy.test/gh" });
    expect(other.config.graphqlUrl).toBe("https://proxy.test/gh/graphql");
    expect(other.config.host).toBe("github.com");
  });
});

describe("resolveGitHubHost: normalization and rejection", () => {
  test("trims, strips trailing slash, lowercases the host, keeps the port", () => {
    const { config } = resolved({ GITHUB_URL: "  https://GHE.Corp:8443/ " });
    expect(config.webUrl).toBe("https://ghe.corp:8443");
    expect(config.host).toBe("ghe.corp:8443");
    expect(config.apiUrl).toBe("https://ghe.corp:8443/api/v3");
  });

  test("http: is accepted with a warning", () => {
    const result = resolved({ GITHUB_URL: "http://ghe.lab" });
    expect(result.warning).toContain("http://");
    expect(resolved({ GITHUB_URL: "https://ghe.lab" }).warning).toBeUndefined();
  });

  test.each([
    ["path", "https://ghe.corp/github"],
    ["credentials", "https://user:pw@ghe.corp"],
    ["query", "https://ghe.corp?x=1"],
    ["fragment", "https://ghe.corp#x"],
    ["scheme", "ftp://ghe.corp"],
    ["garbage", "not a url"],
  ])("rejects %s", (_label, url) => {
    expect(resolveGitHubHost({ GITHUB_URL: url }).ok).toBe(false);
  });

  test("an invalid value throws from the getters instead of falling back", () => {
    process.env.GITHUB_URL = "ftp://ghe.corp";
    expect(() => githubApiUrl("/user")).toThrow("Invalid GitHub host config");
  });
});

describe("isGitHubUrl and detectVcsProvider", () => {
  test("default mode keeps today's detection", () => {
    expect(isGitHubUrl("https://github.com/o/r")).toBe(true);
    expect(isGitHubUrl("git@github.com:o/r.git")).toBe(true);
    expect(isGitHubUrl("https://www.github.com/o/r")).toBe(true);
    expect(isGitHubUrl("https://ghe.test/o/r")).toBe(false);
    expect(detectVcsProvider("https://github.com/o/r")).toBe("github");
    expect(detectVcsProvider("o/r")).toBe("github");
    expect(detectVcsProvider("https://ghe.test/o/r")).toBeNull();
    expect(detectVcsProvider("https://gitlab.com/o/r")).toBe("gitlab");
  });

  test("GHES mode detects the configured host (https, ssh, scp, port)", () => {
    process.env.GITHUB_URL = "https://ghe.test:8443";
    expect(isGitHubUrl("https://ghe.test:8443/o/r")).toBe(true);
    expect(isGitHubUrl("git@ghe.test:o/r.git")).toBe(true);
    expect(isGitHubUrl("https://www.github.com/o/r")).toBe(false);
    expect(detectVcsProvider("https://ghe.test:8443/o/r")).toBe("github");
    expect(detectVcsProvider("o/r")).toBe("github");
  });

  test("GHES host wins over the loose gitlab. substring", () => {
    process.env.GITHUB_URL = "https://gitlab.corp.example";
    expect(detectVcsProvider("https://gitlab.corp.example/o/r")).toBe("github");
    expect(detectVcsProvider("https://gitlab.com/o/r")).toBe("gitlab");
  });
});

describe("parsers and builders", () => {
  test("default mode: links and citations are byte-identical", () => {
    expect(githubWebLink("/o/r")).toBe("https://github.com/o/r");
    expect(githubCitationUrl("o/r#7")).toBe("https://github.com/o/r/issues/7");
    expect(githubCitationUrl("https://www.github.com/o/r/pull/7/files")).toBe(
      "https://github.com/o/r/pull/7",
    );
    expect(githubCitationUrl("https://ghe.test/o/r/pull/7")).toBeNull();
    expect(getGitHubHostForSql()).toBe("github.com");
  });

  test("GHES mode: PRs, citations and SQL host target the GHES host", () => {
    process.env.GITHUB_URL = "https://ghe.test";
    expect(extractGitHubPullRequestUrls("see https://ghe.test/o/r/pull/7).")).toEqual([
      { url: "https://ghe.test/o/r/pull/7", owner: "o", repo: "r", number: 7 },
    ]);
    expect(extractGitHubPullRequestUrls("https://github.com/o/r/pull/7")).toEqual([]);
    expect(githubCitationUrl("o/r#7")).toBe("https://ghe.test/o/r/issues/7");
    expect(githubCitationUrl("o/r@ABCDEF1")).toBe("https://ghe.test/o/r/commit/abcdef1");
    expect(githubCitationUrl("https://ghe.test/o/r/pull/7")).toBe("https://ghe.test/o/r/pull/7");
    expect(githubCitationUrl("https://github.com/o/r/pull/7")).toBeNull();
    expect(getGitHubHostForSql()).toBe("ghe.test");
  });
});

describe("OAuth preset, credential binding and managed guard", () => {
  test("default mode: GitHub preset and binding unchanged", () => {
    const preset = getOAuthPreset("github");
    expect(preset?.authorizeUrl).toBe("https://github.com/login/oauth/authorize");
    expect(preset?.tokenUrl).toBe("https://github.com/login/oauth/access_token");
    expect(preset?.userinfoUrl).toBe("https://api.github.com/user");
    expect(defaultCredentialBindings()[0]?.allowedHosts).toEqual(["api.github.com"]);
    expect(normalizeRepoUrl("o/r")).toBe("https://github.com/o/r");
  });

  test("GHES mode: preset and binding point at the GHES host only", () => {
    process.env.GITHUB_URL = "https://ghe.test";
    const preset = getOAuthPreset("github");
    expect(preset?.authorizeUrl).toBe("https://ghe.test/login/oauth/authorize");
    expect(preset?.tokenUrl).toBe("https://ghe.test/login/oauth/access_token");
    expect(preset?.userinfoUrl).toBe("https://ghe.test/api/v3/user");
    expect(preset?.setupHints.join(" ")).toContain("https://ghe.test/settings/developers");
    expect(listOAuthPresets().find((p) => p.id === "github")?.authorizeUrl).toBe(
      preset?.authorizeUrl,
    );
    // The PAT must never be offered to api.github.com.
    expect(defaultCredentialBindings()[0]?.allowedHosts).toEqual(["ghe.test"]);
    expect(() => normalizeRepoUrl("o/r")).toThrow("GitHub Enterprise Server");
  });
});
