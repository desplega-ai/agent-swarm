import { describe, expect, test } from "bun:test";
import { getFileKind } from "./file-kinds";

describe("getFileKind", () => {
  test("markdown", () => {
    expect(getFileKind("notes.md")).toBe("markdown");
    expect(getFileKind("page.MDX")).toBe("markdown");
  });

  test("tables", () => {
    expect(getFileKind("data.csv")).toBe("table");
    expect(getFileKind("data.tsv")).toBe("table");
  });

  test("media", () => {
    for (const name of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.svg", "a.webp", "a.ico"]) {
      expect(getFileKind(name)).toBe("image");
    }
    for (const name of ["a.mp4", "a.webm", "a.ogv", "a.mov", "a.m4v"]) {
      expect(getFileKind(name)).toBe("video");
    }
    expect(getFileKind("report.pdf")).toBe("pdf");
  });

  test("text and code", () => {
    for (const name of ["app.ts", "a.tsx", "a.json", "a.yaml", "a.py", "a.sql", "a.log", "a.txt"]) {
      expect(getFileKind(name)).toBe("text");
    }
    expect(getFileKind("Makefile")).toBe("text");
    expect(getFileKind("Dockerfile")).toBe("text");
  });

  test("HTML shows as source text", () => {
    expect(getFileKind("page.html")).toBe("text");
    expect(getFileKind("page.htm", "text/html")).toBe("text");
  });

  test("binary files get the fallback, whatever the content type", () => {
    for (const name of ["blob.bin", "a.zip", "a.mp3", "a.docx", "a.mkv", "a.woff2"]) {
      expect(getFileKind(name, "application/octet-stream")).toBe("fallback");
    }
    expect(getFileKind("a.bin", "text/plain")).toBe("fallback");
  });

  test("unknown extensions follow the content type", () => {
    expect(getFileKind("notes.weird", "text/plain")).toBe("text");
    expect(getFileKind("data.weird", "application/vnd.api+json")).toBe("text");
    expect(getFileKind("data.weird", "application/octet-stream")).toBe("fallback");
    expect(getFileKind("data.weird")).toBe("fallback");
  });
});
