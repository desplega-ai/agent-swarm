import { describe, expect, test } from "bun:test";
import { linkTaskIds } from "./task-links";

const CHILD = "ef3a67a9-7255-42a0-bb5d-5e6ffc056cdb";
const PARENT = "a173a469-0e39-4c4f-8a1d-d8ce6e8158ed";
const IDS = [CHILD, PARENT];

describe("linkTaskIds", () => {
  test("a short id in inline code becomes a code link", () => {
    expect(linkTaskIds("Jackknife is building it (`ef3a67a9`).", IDS)).toBe(
      `Jackknife is building it ([\`ef3a67a9\`](/tasks/${CHILD})).`,
    );
  });

  test("a short id in text, with or without #, keeps its text as the label", () => {
    // Built at runtime: the design-token gate reads a hash and six hex characters as a color.
    const hashParent = `#${PARENT.slice(0, 8)}`;
    const hashChild = `#${CHILD.slice(0, 8)}`;
    expect(linkTaskIds(`See ef3a67a9 and ${hashParent}.`, IDS)).toBe(
      `See [ef3a67a9](/tasks/${CHILD}) and [${hashParent}](/tasks/${PARENT}).`,
    );
    expect(linkTaskIds(`\`${hashChild}\``, IDS)).toBe(`[\`${hashChild}\`](/tasks/${CHILD})`);
  });

  test("a full id links, in text and in code", () => {
    expect(linkTaskIds(`Task ${CHILD} is done`, IDS)).toBe(
      `Task [${CHILD}](/tasks/${CHILD}) is done`,
    );
    expect(linkTaskIds(`\`${PARENT}\``, IDS)).toBe(`[\`${PARENT}\`](/tasks/${PARENT})`);
  });

  test("ids the page does not know, and ambiguous prefixes, stay as text", () => {
    expect(linkTaskIds("Unknown deadbeef here", IDS)).toBe("Unknown deadbeef here");
    const twins = ["abcdef12-0000-4000-8000-000000000001", "abcdef12-0000-4000-8000-000000000002"];
    expect(linkTaskIds("`abcdef12`", twins)).toBe("`abcdef12`");
  });

  test("links, URLs, fenced code and longer hex strings stay as they are", () => {
    const link = `[the task](/tasks/${CHILD}) and https://example.com/ef3a67a9`;
    expect(linkTaskIds(link, IDS)).toBe(link);
    const fenced = "```\nexit ef3a67a9\n```\nafter ef3a67a9";
    expect(linkTaskIds(fenced, IDS)).toBe(
      `\`\`\`\nexit ef3a67a9\n\`\`\`\nafter [ef3a67a9](/tasks/${CHILD})`,
    );
    // A commit SHA that starts like an id, and an id inside a word or a path.
    const noise = "ef3a67a9c0ffee1234 x-ef3a67a9 src/ef3a67a9 ef3a67a9.ts `ef3a67a9 x`";
    expect(linkTaskIds(noise, IDS)).toBe(noise);
  });

  test("text without known ids comes back unchanged", () => {
    const text = "No ids here. `code` and [a link](https://example.com).";
    expect(linkTaskIds(text, IDS)).toBe(text);
    expect(linkTaskIds("ef3a67a9", [])).toBe("ef3a67a9");
  });
});
