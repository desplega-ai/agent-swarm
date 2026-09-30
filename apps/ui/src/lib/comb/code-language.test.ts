import { describe, expect, test } from "bun:test";
import { Prism } from "prism-react-renderer";
import {
  HIGHLIGHT_MAX_CHARS,
  prismLanguage,
  prismLanguageForFence,
  prismLanguageForPath,
} from "./code-language";

describe("prismLanguage", () => {
  test("file extensions with a bundled grammar", () => {
    const cases: Array<[string, string]> = [
      ["/src/a.ts", "ts"],
      ["/src/a.tsx", "tsx"],
      ["/src/a.mts", "typescript"],
      ["/src/a.js", "js"],
      ["/src/a.cjs", "javascript"],
      ["/src/a.jsx", "jsx"],
      ["/data/a.json", "json"],
      ["/data/a.ndjson", "json"],
      ["/site/a.css", "css"],
      ["/site/a.html", "markup"],
      ["/site/a.HTM", "markup"],
      ["/site/a.svg", "markup"],
      ["/docs/a.md", "md"],
      ["/docs/a.mdx", "markdown"],
      ["/py/a.py", "py"],
      ["/go/a.go", "go"],
      ["/rs/a.rs", "rust"],
      ["/ci/a.yaml", "yaml"],
      ["/ci/a.yml", "yml"],
      ["/db/a.sql", "sql"],
      ["/api/a.graphql", "graphql"],
      ["/c/a.h", "c"],
      ["/c/a.cpp", "cpp"],
    ];
    for (const [path, grammar] of cases) {
      expect([path, prismLanguageForPath(path)]).toEqual([path, grammar]);
    }
  });

  test("every name it returns is a bundled grammar", () => {
    const names = ["ts", "mjs", "jsonl", "html", "xml", "mdx", "rs", "golang", "hpp", "c++", "gql"];
    for (const name of names) {
      const id = prismLanguage(name);
      expect(id).not.toBeNull();
      expect(typeof (Prism.languages as Record<string, unknown>)[id ?? ""]).toBe("object");
    }
  });

  test("no bundled grammar, plain text, or no extension: null (the file stays plain)", () => {
    for (const path of ["/run.sh", "/Cargo.toml", "/a.rb", "/A.java", "/notes.txt", "/app.log"]) {
      expect([path, prismLanguageForPath(path)]).toEqual([path, null]);
    }
    for (const path of ["/Makefile", "/README", "/.env", "/data.csv"]) {
      expect([path, prismLanguageForPath(path)]).toEqual([path, null]);
    }
    expect(prismLanguage("")).toBeNull();
    expect(prismLanguage(null)).toBeNull();
    // Prism's helpers on `Prism.languages` are not grammars.
    expect(prismLanguage("extend")).toBeNull();
    expect(prismLanguage("insertBefore")).toBeNull();
  });

  test("a fence names its language in a `language-*` class", () => {
    expect(prismLanguageForFence("language-ts")).toBe("ts");
    expect(prismLanguageForFence("language-TypeScript")).toBe("typescript");
    expect(prismLanguageForFence("hljs language-python")).toBe("python");
    expect(prismLanguageForFence("language-c++")).toBe("cpp");
    expect(prismLanguageForFence("language-sh")).toBeNull();
    expect(prismLanguageForFence("language-text")).toBeNull();
    expect(prismLanguageForFence(undefined)).toBeNull();
    expect(prismLanguageForFence("")).toBeNull();
  });

  test("the size cap is 128 KiB", () => {
    expect(HIGHLIGHT_MAX_CHARS).toBe(128 * 1024);
  });
});
