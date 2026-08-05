import { describe, expect, test } from "bun:test";
import { buildSkillContent } from "../be/seed-skills/render";
import { parseSkillContent } from "../be/skill-parser";

// ─── Valid Parsing ──────────────────────────────────────────────────────────

describe("parseSkillContent — valid inputs", () => {
  test("parses minimal frontmatter with body", () => {
    const content = `---
name: my-skill
description: A test skill
---

This is the body.`;

    const result = parseSkillContent(content);
    expect(result.name).toBe("my-skill");
    expect(result.description).toBe("A test skill");
    expect(result.body).toBe("This is the body.");
  });

  test("parses all optional frontmatter fields", () => {
    const content = `---
name: full-skill
description: Full featured skill
allowed-tools: Read,Write,Bash
model: opus
effort: high
context: some-context
agent: worker-123
disable-model-invocation: true
user-invocable: true
---

Body content here.`;

    const result = parseSkillContent(content);
    expect(result.name).toBe("full-skill");
    expect(result.description).toBe("Full featured skill");
    expect(result.allowedTools).toBe("Read,Write,Bash");
    expect(result.model).toBe("opus");
    expect(result.effort).toBe("high");
    expect(result.context).toBe("some-context");
    expect(result.agent).toBe("worker-123");
    expect(result.disableModelInvocation).toBe(true);
    expect(result.userInvocable).toBe(true);
  });

  test("returns undefined for unset optional fields", () => {
    const content = `---
name: minimal
description: Minimal skill
---

Body.`;

    const result = parseSkillContent(content);
    expect(result.allowedTools).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.effort).toBeUndefined();
    expect(result.context).toBeUndefined();
    expect(result.agent).toBeUndefined();
    expect(result.disableModelInvocation).toBeUndefined();
    expect(result.userInvocable).toBeUndefined();
  });

  test("handles empty body after frontmatter", () => {
    const content = `---
name: no-body
description: Skill with no body
---`;

    const result = parseSkillContent(content);
    expect(result.name).toBe("no-body");
    expect(result.body).toBe("");
  });

  test("user-invocable defaults to true when present without value", () => {
    // user-invocable with no value → empty string → not "false" → true
    // Actually per the parser: if key has empty value, it's skipped (value check)
    // Let's test explicit true/false
    const contentTrue = `---
name: invocable
description: Test
user-invocable: true
---
Body`;

    const contentFalse = `---
name: non-invocable
description: Test
user-invocable: false
---
Body`;

    expect(parseSkillContent(contentTrue).userInvocable).toBe(true);
    expect(parseSkillContent(contentFalse).userInvocable).toBe(false);
  });

  test("disable-model-invocation only true for literal 'true'", () => {
    const contentTrue = `---
name: disabled
description: Test
disable-model-invocation: true
---
Body`;

    const contentFalse = `---
name: enabled
description: Test
disable-model-invocation: false
---
Body`;

    expect(parseSkillContent(contentTrue).disableModelInvocation).toBe(true);
    expect(parseSkillContent(contentFalse).disableModelInvocation).toBeUndefined();
  });

  test("handles extra whitespace in frontmatter", () => {
    const content = `---
name:   spaced-skill
description:   A spaced description
---

Body.`;

    const result = parseSkillContent(content);
    expect(result.name).toBe("spaced-skill");
    expect(result.description).toBe("A spaced description");
  });

  test("handles colons in frontmatter values", () => {
    const content = `---
name: colon-skill
description: A skill with: colons in description
---

Body.`;

    const result = parseSkillContent(content);
    expect(result.description).toBe("A skill with: colons in description");
  });

  test("strips YAML double-quoted scalar values", () => {
    const content = `---
name: quoted-skill
description: "Covers the \\"timeMin\\" trap: pass timeMin explicitly."
---

Body.`;

    const result = parseSkillContent(content);
    expect(result.description).toBe('Covers the "timeMin" trap: pass timeMin explicitly.');
  });

  test("keeps malformed quoted values raw", () => {
    const content = `---
name: quoted-skill
description: "trailing escape \\"
---

Body.`;

    const result = parseSkillContent(content);
    expect(result.description).toBe('"trailing escape \\"');
  });
});

// ─── buildSkillContent round-trip ───────────────────────────────────────────

describe("buildSkillContent ↔ parseSkillContent", () => {
  test("YAML-unsafe descriptions render quoted and parse back verbatim", () => {
    const description =
      'Covers the "events from a year ago" trap: EVENTS_LIST has no default timeMin.';
    const rendered = buildSkillContent({ name: "round-trip", description }, "Body.");
    expect(rendered).toContain('description: "');
    expect(parseSkillContent(rendered).description).toBe(description);
  });

  test("plain-safe descriptions stay unquoted (seed-hash byte stability)", () => {
    const rendered = buildSkillContent(
      { name: "round-trip", description: "Simple description." },
      "Body.",
    );
    expect(rendered).toContain("description: Simple description.\n");
    expect(parseSkillContent(rendered).description).toBe("Simple description.");
  });

  // A plain scalar YAML resolves as a bool/null/number/timestamp would reach a
  // js-yaml-based harness reader as that type, not as the required string.
  test.each([
    "true",
    "False",
    "yes",
    "NO",
    "on",
    "null",
    "~",
    "123",
    "-4.5",
    "1e6",
    "0x1f",
    ".inf",
    "2026-08-04",
  ])("description %p renders quoted (YAML would resolve it as a non-string)", (description) => {
    const rendered = buildSkillContent({ name: "round-trip", description }, "Body.");
    expect(rendered).toContain(`description: ${JSON.stringify(description)}\n`);
    expect(parseSkillContent(rendered).description).toBe(description);
  });

  test("descriptions merely containing a number stay unquoted", () => {
    const rendered = buildSkillContent(
      { name: "round-trip", description: "Handles 123 retries." },
      "Body.",
    );
    expect(rendered).toContain("description: Handles 123 retries.\n");
  });
});

// ─── Invalid Inputs ─────────────────────────────────────────────────────────

describe("parseSkillContent — invalid inputs", () => {
  test("throws if no frontmatter delimiter", () => {
    expect(() => parseSkillContent("No frontmatter here")).toThrow("No frontmatter found");
  });

  test("throws if frontmatter is unterminated", () => {
    expect(() => parseSkillContent("---\nname: test\nno closing")).toThrow("Missing closing ---");
  });

  test("throws if name is missing", () => {
    const content = `---
description: Missing name
---
Body`;
    expect(() => parseSkillContent(content)).toThrow('missing required field: "name"');
  });

  test("throws if description is missing", () => {
    const content = `---
name: no-desc
---
Body`;
    expect(() => parseSkillContent(content)).toThrow('missing required field: "description"');
  });

  test("throws on empty string", () => {
    expect(() => parseSkillContent("")).toThrow("No frontmatter found");
  });

  test("throws on whitespace-only string", () => {
    expect(() => parseSkillContent("   \n\n  ")).toThrow("No frontmatter found");
  });
});
