import { describe, expect, test } from "bun:test";
import { parseMarkdown, walkAst } from "chat";
import { type ChatFile, formatTooLargeReply } from "../integrations/chat-sdk/attachments";

function file(name: string): ChatFile {
  return { id: "f1", adapter: "telegram", messageId: "m1", name };
}

/** Parse the reply the way the Chat SDK does before it renders per platform. */
function rendered(name: string) {
  const markdown = formatTooLargeReply([{ file: file(name), reason: "too large", tooLarge: true }]);
  const nodeTypes = new Set<string>();
  const codeValues: string[] = [];
  walkAst(parseMarkdown(markdown), (node) => {
    nodeTypes.add(node.type);
    if (node.type === "inlineCode") codeValues.push((node as { value: string }).value);
    return node;
  });
  return { markdown, nodeTypes, codeValues };
}

describe("formatTooLargeReply", () => {
  test.each([
    "[Verify your account](https://evil.example/login)",
    "![x](https://evil.example/pixel.png)",
    "https://evil.example/login",
    "www.evil.example",
    "me@evil.example",
    "**urgent** <b>_now_</b>",
    "a`b``c.zip",
    "`quoted`",
    " leading space.zip",
  ])("renders the sender's file name %p as literal text", (name) => {
    const { nodeTypes, codeValues } = rendered(name);
    expect(nodeTypes.has("link")).toBe(false);
    expect(nodeTypes.has("image")).toBe(false);
    expect(nodeTypes.has("strong")).toBe(false);
    expect(nodeTypes.has("emphasis")).toBe(false);
    expect(nodeTypes.has("html")).toBe(false);
    expect(codeValues).toEqual([name]);
  });

  test("a newline in the name cannot start a heading", () => {
    const { nodeTypes, codeValues } = rendered("a.zip\n# Pay here");
    expect(nodeTypes.has("heading")).toBe(false);
    expect(codeValues).toEqual(["a.zip # Pay here"]);
  });

  test("keeps the reason and the plain file name readable", () => {
    expect(rendered("big.zip").markdown).toContain("- `big.zip`: too large");
  });
});
