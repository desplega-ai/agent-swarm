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

  test("returns null for unrecognised URLs", () => {
    expect(detectVcsProvider("https://bitbucket.org/org/repo")).toBeNull();
    expect(detectVcsProvider("https://example.com")).toBeNull();
  });
});
