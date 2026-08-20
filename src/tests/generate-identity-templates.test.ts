import { describe, expect, test } from "bun:test";
import { generateDefaultIdentityMd, generateDefaultSoulMd } from "../prompts/defaults";

describe("generateDefaultSoulMd", () => {
  test("should generate template with just name", () => {
    const result = generateDefaultSoulMd({ name: "TestAgent" });

    expect(result).toContain("# SOUL.md: TestAgent");
    expect(result).toContain("I am TestAgent in the agent swarm");
    expect(result).toContain("## How I work");
    expect(result).toContain("## Boundaries");
    expect(result).toContain("## Growth");
  });

  test("should include role in who you are section", () => {
    const result = generateDefaultSoulMd({ name: "TestAgent", role: "frontend dev" });

    expect(result).toContain("I am TestAgent, a frontend dev in the agent swarm");
  });

  test("should not include role clause when role is undefined", () => {
    const result = generateDefaultSoulMd({ name: "TestAgent" });

    expect(result).toContain("I am TestAgent in the agent swarm");
    expect(result).not.toContain(", a ");
  });

  test("should contain personality-forming directives", () => {
    const result = generateDefaultSoulMd({ name: "TestAgent" });

    expect(result).toContain("Results first, context after.");
    expect(result).toContain("I find out for myself first");
    expect(result).toContain("A guess is labeled as a guess.");
    expect(result).toContain("I report blockers as they are.");
  });

  test("should handle special characters in name", () => {
    const result = generateDefaultSoulMd({ name: "Test Agent (v2.0)" });

    expect(result).toContain("# SOUL.md: Test Agent (v2.0)");
  });
});

describe("generateDefaultIdentityMd", () => {
  test("should generate template with just name", () => {
    const result = generateDefaultIdentityMd({ name: "TestAgent" });

    expect(result).toContain("# IDENTITY.md: TestAgent");
    expect(result).toContain("- Name: TestAgent");
    expect(result).toContain("- Role: worker");
    expect(result).toContain("## Working style");
    expect(result).toContain("## Quirks");
  });

  test("should include role when provided", () => {
    const result = generateDefaultIdentityMd({ name: "TestAgent", role: "code reviewer" });

    expect(result).toContain("- Role: code reviewer");
  });

  test("should default role to worker", () => {
    const result = generateDefaultIdentityMd({ name: "TestAgent" });

    expect(result).toContain("- Role: worker");
  });

  test("should include about section when description provided", () => {
    const result = generateDefaultIdentityMd({
      name: "TestAgent",
      description: "A helpful test agent for QA",
    });

    expect(result).toContain("## About");
    expect(result).toContain("A helpful test agent for QA");
  });

  test("should not include about section when no description", () => {
    const result = generateDefaultIdentityMd({ name: "TestAgent" });

    expect(result).not.toContain("## About");
  });

  test("should include expertise section when capabilities provided", () => {
    const result = generateDefaultIdentityMd({
      name: "TestAgent",
      capabilities: ["typescript", "react", "testing"],
    });

    expect(result).toContain("## Expertise");
    expect(result).toContain("- typescript");
    expect(result).toContain("- react");
    expect(result).toContain("- testing");
  });

  test("should not include expertise section when no capabilities", () => {
    const result = generateDefaultIdentityMd({ name: "TestAgent", capabilities: [] });

    expect(result).not.toContain("## Expertise");
  });

  test("should include all fields when fully specified", () => {
    const result = generateDefaultIdentityMd({
      name: "FullAgent",
      description: "A fully configured agent",
      role: "Senior Engineer",
      capabilities: ["python", "docker"],
    });

    expect(result).toContain("# IDENTITY.md: FullAgent");
    expect(result).toContain("- Name: FullAgent");
    expect(result).toContain("- Role: Senior Engineer");
    expect(result).toContain("## About");
    expect(result).toContain("A fully configured agent");
    expect(result).toContain("## Expertise");
    expect(result).toContain("- python");
    expect(result).toContain("- docker");
    expect(result).toContain("## Working style");
    expect(result).toContain("## Quirks");
  });
});
