import { describe, expect, test } from "bun:test";
import { generateDefaultClaudeMd } from "../be/db";

describe("generateDefaultClaudeMd", () => {
  test("should generate basic template with just name", () => {
    const result = generateDefaultClaudeMd({ name: "TestAgent" });

    expect(result).toContain("# Agent: TestAgent");
    expect(result).toContain("## Notes");
    expect(result).toContain("### Learnings");
    expect(result).toContain("### Preferences");
    expect(result).toContain("### Important Context");
  });

  test("should include identity file references", () => {
    const result = generateDefaultClaudeMd({ name: "TestAgent" });

    expect(result).toContain("## Your Identity Files");
    expect(result).toContain("/workspace/SOUL.md");
    expect(result).toContain("/workspace/IDENTITY.md");
  });

  test("should include description when provided", () => {
    const result = generateDefaultClaudeMd({
      name: "TestAgent",
      description: "A helpful test agent",
    });

    expect(result).toContain("# Agent: TestAgent");
    expect(result).toContain("A helpful test agent");
  });

  test("should include role section when provided", () => {
    const result = generateDefaultClaudeMd({
      name: "TestAgent",
      role: "Frontend Developer",
    });

    expect(result).toContain("## Role");
    expect(result).toContain("Frontend Developer");
  });

  test("should include capabilities list when provided", () => {
    const result = generateDefaultClaudeMd({
      name: "TestAgent",
      capabilities: ["typescript", "react", "node"],
    });

    expect(result).toContain("## Capabilities");
    expect(result).toContain("- typescript");
    expect(result).toContain("- react");
    expect(result).toContain("- node");
  });

  test("should include all fields when provided", () => {
    const result = generateDefaultClaudeMd({
      name: "FullAgent",
      description: "A fully configured agent",
      role: "Senior Engineer",
      capabilities: ["python", "docker"],
    });

    expect(result).toContain("# Agent: FullAgent");
    expect(result).toContain("A fully configured agent");
    expect(result).toContain("## Role");
    expect(result).toContain("Senior Engineer");
    expect(result).toContain("## Capabilities");
    expect(result).toContain("- python");
    expect(result).toContain("- docker");
    expect(result).toContain("## Notes");
  });

  test("should not include role section when role is undefined", () => {
    const result = generateDefaultClaudeMd({
      name: "TestAgent",
      role: undefined,
    });

    expect(result).not.toContain("## Role");
  });

  test("should not include capabilities section when capabilities is empty", () => {
    const result = generateDefaultClaudeMd({
      name: "TestAgent",
      capabilities: [],
    });

    expect(result).not.toContain("## Capabilities");
  });

  test("should handle special characters in name", () => {
    const result = generateDefaultClaudeMd({
      name: "Test Agent (v2.0)",
    });

    expect(result).toContain("# Agent: Test Agent (v2.0)");
  });
});
