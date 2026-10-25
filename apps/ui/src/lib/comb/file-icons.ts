// The icon kind for a drive entry, by name. Comb draws one mono icon per kind
// (`components/comb/file-icon.tsx`): the dashboard has one accent color, so
// the kind is in the shape, not the color.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { AUDIO_TYPES, fileExtension, IMAGE_EXTS, VIDEO_EXTS } from "./file-kinds";

export type FileIconKind =
  | "folder"
  | "markdown"
  | "text"
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "html"
  | "code"
  | "data"
  | "table"
  | "archive"
  | "file";

const BY_EXTENSION: Readonly<Record<string, FileIconKind>> = {
  md: "markdown",
  mdx: "markdown",
  txt: "text",
  log: "text",
  mkv: "video",
  avi: "video",
  pdf: "pdf",
  html: "html",
  htm: "html",
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  css: "code",
  scss: "code",
  py: "code",
  rb: "code",
  rs: "code",
  go: "code",
  java: "code",
  c: "code",
  cpp: "code",
  h: "code",
  hpp: "code",
  sh: "code",
  bash: "code",
  sql: "code",
  graphql: "code",
  dockerfile: "code",
  makefile: "code",
  json: "data",
  jsonl: "data",
  ndjson: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  xml: "data",
  ini: "data",
  env: "data",
  csv: "table",
  tsv: "table",
  xls: "table",
  xlsx: "table",
  ods: "table",
  zip: "archive",
  gz: "archive",
  tgz: "archive",
  tar: "archive",
  bz2: "archive",
  xz: "archive",
  "7z": "archive",
  rar: "archive",
};

/** The icon kind for `name`. A folder is always `folder`. */
export function fileIconKind(name: string, isFolder: boolean): FileIconKind {
  if (isFolder) return "folder";
  const ext = fileExtension(name);
  // The viewer's own lists: an image icon means Comb shows the image.
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (Object.hasOwn(AUDIO_TYPES, ext)) return "audio";
  return Object.hasOwn(BY_EXTENSION, ext) ? (BY_EXTENSION[ext] as FileIconKind) : "file";
}
