import { describe, expect, test } from "bun:test";
import { markdownPreview } from "./markdown-preview";

describe("markdownPreview", () => {
  test("drops marks, link targets, headings, lists, and fences", () => {
    expect(
      markdownPreview(
        "## Done\n\n- **Fixed** the [brand guide](https://x.io/a) link\n- Ran `bun test`\n\n```ts\nconst a = 1;\n```",
      ),
    ).toBe("Done Fixed the brand guide link Ran bun test const a = 1;");
  });

  test("keeps snake_case words and plain text", () => {
    expect(markdownPreview("Set agent_max_tasks to 2. Nothing else changed.")).toBe(
      "Set agent_max_tasks to 2. Nothing else changed.",
    );
  });
});
