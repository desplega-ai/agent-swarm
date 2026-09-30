// Which Prism grammar highlights a Comb code file or a markdown fence. Comb
// uses the grammars that prism-react-renderer bundles, like the rest of the
// dashboard (`script-runs/source-view.tsx`, `shared/session-log-viewer.tsx`).
// It bundles no shell, TOML, Ruby, or Java grammar: those files stay plain.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { Prism } from "prism-react-renderer";
import { fileExtension } from "./file-kinds";

// Extensions and fence labels that Prism does not register as a name or alias.
// Prism registers html, xml, and svg too, but the theme picks its markup
// colors by the name "markup".
const ALIASES: Record<string, string> = {
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  jsonl: "json",
  ndjson: "json",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  mdx: "markdown",
  rs: "rust",
  golang: "go",
  h: "c",
  hpp: "cpp",
  "c++": "cpp",
  gql: "graphql",
};

// Prism's names for plain text. Tokens would add nothing.
const PLAIN = new Set(["plain", "plaintext", "text", "txt"]);

/**
 * Highlight text up to this many characters (UTF-16 code units, the byte
 * count for ASCII source). A larger file or fence renders plain. Measured on
 * this repo's TypeScript (2026-09-30, Apple silicon, production build):
 * - Prism tokenizes a whole file in one synchronous call, and its time grows
 *   faster than the size: 128 KiB 25-40 ms, 256 KiB 70-100 ms, 512 KiB 0.6 s,
 *   1 MiB 14 s, 2 MiB 112 s.
 * - The browser then styles and lays out one span per colored token. The
 *   task that shows the highlighted rows took 157 ms at 64 KiB (2,000 lines),
 *   375 ms at 128 KiB (3,700 lines), and 595 ms at 244 KiB (7,200 lines).
 * 128 KiB keeps that one task under about 400 ms and covers most source files.
 */
export const HIGHLIGHT_MAX_CHARS = 128 * 1024;

/**
 * The Prism grammar for a language name (a fence label or a file extension),
 * or null when there is no bundled grammar or the name means plain text.
 */
export function prismLanguage(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  const id = ALIASES[key] ?? key;
  if (PLAIN.has(id) || !Object.hasOwn(Prism.languages, id)) return null;
  return typeof (Prism.languages as Record<string, unknown>)[id] === "object" ? id : null;
}

/** The Prism grammar for a file path, from its extension. */
export function prismLanguageForPath(path: string): string | null {
  return prismLanguage(fileExtension(path));
}

/** The language a fence names in its `language-*` class, as a Prism grammar. */
export function prismLanguageForFence(className: string | undefined): string | null {
  return prismLanguage(/(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1]);
}
