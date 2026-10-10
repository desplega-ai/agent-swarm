import { describe, expect, test } from "bun:test";
import { getFileKind, looksLikeText, needsSniff, SNIFF_MAX_BYTES } from "./file-kinds";

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
    // agent-fs stores `.htm` as octet-stream.
    expect(getFileKind("page.htm")).toBe("text");
    expect(getFileKind("page.htm", "application/octet-stream", 10 * 1024 * 1024)).toBe("text");
  });

  test("binary files get the fallback, whatever the content type", () => {
    for (const name of ["blob.bin", "a.zip", "a.mp3", "a.docx", "a.mkv", "a.woff2"]) {
      expect(getFileKind(name, "application/octet-stream", 10)).toBe("fallback");
    }
    expect(getFileKind("a.bin", "text/plain")).toBe("fallback");
  });

  test("OOXML documents are binary, although their type names xml", () => {
    const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    expect(getFileKind("sheet.xlsx", xlsx, 10)).toBe("fallback");
    for (const name of ["a.xlsm", "a.pptm", "a.docm", "a.vsdx"]) {
      expect(getFileKind(name, "application/octet-stream", 10)).toBe("fallback");
    }
    expect(getFileKind("sheet.weird", xlsx, 10)).toBe("fallback");
  });

  test("unknown extensions follow the content type", () => {
    expect(getFileKind("notes.weird", "text/plain")).toBe("text");
    expect(getFileKind("notes.weird", "text/plain; charset=utf-8")).toBe("text");
    expect(getFileKind("data.weird", "application/vnd.api+json")).toBe("text");
    expect(getFileKind("feed.weird", "application/atom+xml")).toBe("text");
    expect(getFileKind("data.weird", "application/xml")).toBe("text");
    expect(getFileKind("app.weird", "application/javascript")).toBe("text");
    expect(getFileKind("data.weird", "application/xml-dtd")).toBe("fallback");
    expect(getFileKind("data.weird", "application/zip")).toBe("fallback");
  });

  test("an unknown octet-stream file is text only when small", () => {
    expect(needsSniff("README", "application/octet-stream")).toBe(true);
    expect(needsSniff("README")).toBe(true);
    expect(needsSniff("notes.txt", "application/octet-stream")).toBe(false);
    expect(needsSniff("README", "text/plain")).toBe(false);
    expect(getFileKind("README", "application/octet-stream", 1200)).toBe("text");
    expect(getFileKind("LICENSE", undefined, 1200)).toBe("text");
    expect(getFileKind("blob", "application/octet-stream", SNIFF_MAX_BYTES)).toBe("fallback");
    // No size: the stat is unknown, so do not guess.
    expect(getFileKind("data.weird", "application/octet-stream")).toBe("fallback");
  });
});

describe("looksLikeText", () => {
  test("text bytes pass", () => {
    expect(looksLikeText("# README\n\nPlain text, ünïcödé, and tabs\t.\n")).toBe(true);
    expect(looksLikeText("")).toBe(true);
  });

  test("a NUL byte in the first 8 KiB fails", () => {
    const blob = new TextDecoder().decode(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff]),
    );
    expect(looksLikeText(blob)).toBe(false);
    expect(looksLikeText(`${"a".repeat(8 * 1024 - 1)}\u0000`)).toBe(false);
  });

  test("only the first 8 KiB counts", () => {
    expect(looksLikeText(`${"a".repeat(8 * 1024)}\u0000`)).toBe(true);
  });
});
