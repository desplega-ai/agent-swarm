import { describe, expect, test } from "bun:test";
import { outcomePreview, type PreviewSource } from "./outcome-preview";

const done = (output: string, extra: Partial<PreviewSource> = {}): PreviewSource => ({
  status: "completed",
  output,
  task: "Republish the page",
  ...extra,
});

describe("outcomePreview", () => {
  test("a JSON object: the human fields first, then strings, numbers, and list counts", () => {
    const output = JSON.stringify({
      pr: "https://github.com/acme/app/pull/2589",
      diffLines: 1,
      published: false,
      files: ["a", "b"],
      nested: { skip: true },
      summary: "Staged",
    });
    expect(outcomePreview(done(output), false)).toBe(
      "summary: Staged · pr: PR #2589 · diffLines: 1 · published: false · files: 2 items",
    );
  });

  test("a JSON object the 2 KB cut breaks keeps its leading fields", () => {
    const output = JSON.stringify({
      candidateName: "grm-daily-growth-publish-partial-candidate",
      contentHash: "44a74526",
      diffLines: 1,
      notes: "x".repeat(3000),
      after: "never read",
    });
    expect(outcomePreview(done(output), false)).toBe(
      "candidateName: grm-daily-growth-publish-partial-candidate · contentHash: 44a74526 · diffLines: 1",
    );
  });

  test("a cut object that starts with a nested value reads as text", () => {
    const output = `{"items":[${Array.from({ length: 400 }, (_, i) => `"item-${i}"`).join(",")}]}`;
    expect(outcomePreview(done(output), false)).toStartWith('{"items":["item-0"');
  });

  test("an empty structured output reads the progress, else the task's first line", () => {
    expect(outcomePreview(done("{}", { progress: "Round 2 queued" }), false)).toBe(
      "Round 2 queued",
    );
    expect(outcomePreview(done("[]"), false)).toBe("Republish the page");
  });

  test("shortens bare SHAs, and an open row reads the task's first line", () => {
    const sha = "b9cf86ea2e5a0ab8b5b990637f2f84f6f5924e2c";
    expect(outcomePreview(done(`Head is ${sha}.`), false)).toBe("Head is b9cf86ea.");
    expect(outcomePreview(done(`Head is ${sha}.`), true)).toBe("Republish the page");
  });
});
