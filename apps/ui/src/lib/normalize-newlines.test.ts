import { describe, expect, test } from "bun:test";
import { normalizeNewlines } from "./utils";

describe("normalizeNewlines", () => {
  test("doubles single newlines in prose and keeps list markers", () => {
    expect(normalizeNewlines("one\ntwo\n- item\n- item")).toBe("one\n\ntwo\n- item\n- item");
  });

  test("leaves the inside of a fenced code block untouched", () => {
    const fenced = "```\nline one\nline two\n\nline four\n```";
    expect(normalizeNewlines(`Draft:\n${fenced}\nAfter`)).toBe(`Draft:\n\n${fenced}\n\nAfter`);
  });

  test("handles fences with a language, tildes, and longer closers", () => {
    expect(normalizeNewlines("```ts\nconst a = 1;\nconst b = 2;\n```")).toBe(
      "```ts\nconst a = 1;\nconst b = 2;\n```",
    );
    expect(normalizeNewlines("~~~\na\nb\n~~~~\nc\nd")).toBe("~~~\na\nb\n~~~~\n\nc\n\nd");
  });

  test("an unclosed fence protects everything after it", () => {
    expect(normalizeNewlines("text\n```\na\nb")).toBe("text\n\n```\na\nb");
  });
});
