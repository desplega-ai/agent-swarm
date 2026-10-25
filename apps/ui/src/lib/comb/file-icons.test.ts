import { describe, expect, test } from "bun:test";
import { fileIconKind } from "./file-icons";

describe("fileIconKind", () => {
  test("a folder is a folder, whatever its name", () => {
    expect(fileIconKind("notes.md", true)).toBe("folder");
  });

  test("one kind per family of extensions, case does not matter", () => {
    const cases: [string, string][] = [
      ["plan.md", "markdown"],
      ["README.MDX", "markdown"],
      ["notes.txt", "text"],
      ["shot.PNG", "image"],
      ["logo.svg", "image"],
      ["call.mp3", "audio"],
      ["voice.opus", "audio"],
      ["demo.mov", "video"],
      ["deck.pdf", "pdf"],
      ["page.htm", "html"],
      ["index.tsx", "code"],
      ["Dockerfile", "code"],
      ["Makefile", "code"],
      ["config.yaml", "data"],
      ["rows.jsonl", "data"],
      ["users.csv", "table"],
      ["model.xlsx", "table"],
      ["backup.tar", "archive"],
    ];
    for (const [name, kind] of cases) expect(fileIconKind(name, false)).toBe(kind as never);
  });

  test("an unknown or missing extension is a plain file", () => {
    expect(fileIconKind("LICENSE", false)).toBe("file");
    expect(fileIconKind("data.bin", false)).toBe("file");
    expect(fileIconKind(".keep", false)).toBe("file");
  });
});
