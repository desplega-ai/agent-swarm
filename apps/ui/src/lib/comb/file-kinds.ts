// Which Comb viewer opens a file. The extension lists come from agent-fs
// `live/src/components/viewers/FileViewer.tsx` (v0.14.0). Keep them in sync.

export type FileKind = "markdown" | "text" | "image" | "video" | "pdf" | "table" | "fallback";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"]);

// Browser-playable video containers. Other containers (mkv, avi) get the fallback.
const VIDEO_EXTS = new Set(["mp4", "webm", "ogv", "mov", "m4v"]);

// Known-binary extensions that never render as text, even when the stored
// content type is the generic `application/octet-stream`.
const BINARY_EXTS = new Set([
  ...VIDEO_EXTS,
  "mkv",
  "avi",
  "wmv",
  "flv",
  "mp3",
  "wav",
  "flac",
  "aac",
  "m4a",
  "ogg",
  "opus",
  "zip",
  "gz",
  "tar",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "wasm",
  "bin",
  "exe",
  "dll",
  "so",
  "dylib",
  "o",
  "a",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "odt",
  "ods",
  "odp",
]);

const TEXT_EXTS = new Set([
  "txt",
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "jsonl",
  "ndjson",
  "md",
  "mdx",
  "css",
  "scss",
  "html",
  "xml",
  "yaml",
  "yml",
  "toml",
  "sh",
  "bash",
  "py",
  "rb",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "sql",
  "graphql",
  "env",
  "cfg",
  "ini",
  "conf",
  "log",
  "csv",
  "tsv",
  "dockerfile",
  "makefile",
  "lock",
]);

/** Lowercase extension, or the whole name when it has no dot ("Makefile" → "makefile"). */
export function fileExtension(name: string): string {
  const base = name.split("/").pop() ?? "";
  return (base.split(".").pop() ?? "").toLowerCase();
}

function isTextContentType(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return (
    type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("xml") ||
    type.includes("javascript") ||
    type.includes("typescript")
  );
}

/**
 * The viewer kind for a file name. HTML is `text` (Comb shows the source and
 * never renders it). An unknown extension opens as text only when agent-fs
 * reports a text-like content type.
 */
export function getFileKind(name: string, contentType?: string): FileKind {
  const ext = fileExtension(name);
  if (ext === "md" || ext === "mdx") return "markdown";
  if (ext === "csv" || ext === "tsv") return "table";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (BINARY_EXTS.has(ext)) return "fallback";
  if (TEXT_EXTS.has(ext)) return "text";
  if (contentType && isTextContentType(contentType)) return "text";
  return "fallback";
}
