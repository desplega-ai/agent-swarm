// Which Comb viewer opens a file. The extension lists come from agent-fs
// `live/src/components/viewers/FileViewer.tsx` (v0.14.0) and `live/src/lib/audio.ts`
// (v0.18.5). Keep them in sync. Comb adds `htm` (text) and the OOXML
// extensions (binary).

export type FileKind =
  | "markdown"
  | "text"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "table"
  | "fallback";

export const IMAGE_EXTS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "ico",
]);

// Browser-playable video containers. Other containers (mkv, avi) get the fallback.
export const VIDEO_EXTS: ReadonlySet<string> = new Set(["mp4", "webm", "ogv", "mov", "m4v"]);

/** Audio containers the browser's `<audio>` element plays, with the type each one is sent as. */
export const AUDIO_TYPES: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
};

/** The audio type for a file name's extension, or null when it is not a known audio container. */
export function audioTypeFor(name: string): string | null {
  const ext = fileExtension(name);
  return Object.hasOwn(AUDIO_TYPES, ext) ? (AUDIO_TYPES[ext] as string) : null;
}

// Known-binary extensions that never render as text, even when the stored
// content type is the generic `application/octet-stream`.
const BINARY_EXTS = new Set([
  ...VIDEO_EXTS,
  "mkv",
  "avi",
  "wmv",
  "flv",
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
  // OOXML (zip) documents.
  "xlsx",
  "xlsm",
  "pptm",
  "docm",
  "vsdx",
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
  // agent-fs stores `.htm` as `application/octet-stream`.
  "htm",
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

/** Unknown files at or above this size open in the fallback viewer, unread. */
export const SNIFF_MAX_BYTES = 256 * 1024;

/** How much of an unknown file `looksLikeText` checks. */
const SNIFF_HEAD_CHARS = 8 * 1024;

// Text types named in full. `text/*`, `+json`, and `+xml` match by pattern.
const TEXT_CONTENT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-typescript",
]);

/** The media type without parameters ("text/plain; charset=utf-8" → "text/plain"). */
function mediaType(contentType: string | undefined): string {
  return (contentType?.split(";")[0] ?? "").trim().toLowerCase();
}

function isTextContentType(contentType: string): boolean {
  const type = mediaType(contentType);
  return (
    type.startsWith("text/") ||
    TEXT_CONTENT_TYPES.has(type) ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

function isKnownExtension(ext: string): boolean {
  return (
    ["md", "mdx", "csv", "tsv", "pdf"].includes(ext) ||
    IMAGE_EXTS.has(ext) ||
    VIDEO_EXTS.has(ext) ||
    Object.hasOwn(AUDIO_TYPES, ext) ||
    BINARY_EXTS.has(ext) ||
    TEXT_EXTS.has(ext)
  );
}

/**
 * True when neither the extension nor the content type names the kind: an
 * unknown extension that agent-fs stores as `application/octet-stream` (or
 * with no type), such as `README` or `LICENSE`. live/ opens these as text.
 * Comb opens them as text only when the file is under `SNIFF_MAX_BYTES` and
 * `looksLikeText` passes on its bytes.
 */
export function needsSniff(name: string, contentType?: string): boolean {
  const type = mediaType(contentType);
  return (
    (type === "" || type === "application/octet-stream") && !isKnownExtension(fileExtension(name))
  );
}

/** The sniff: text when the first 8 KiB has no NUL byte. */
export function looksLikeText(text: string): boolean {
  return !text.slice(0, SNIFF_HEAD_CHARS).includes("\u0000");
}

/**
 * The viewer kind for a file name. HTML is `text`: the text viewer shows the
 * source, and the HTML viewer adds a sandboxed preview next to it. An unknown
 * extension opens as audio for an `audio/*` content type, and as text when
 * agent-fs reports a text content type, or when `needsSniff` holds and the
 * file (`size` from `stat`) is small. The text viewer then checks the bytes.
 */
export function getFileKind(name: string, contentType?: string, size?: number): FileKind {
  const ext = fileExtension(name);
  if (ext === "md" || ext === "mdx") return "markdown";
  if (ext === "csv" || ext === "tsv") return "table";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (Object.hasOwn(AUDIO_TYPES, ext)) return "audio";
  if (BINARY_EXTS.has(ext)) return "fallback";
  if (TEXT_EXTS.has(ext)) return "text";
  if (mediaType(contentType).startsWith("audio/")) return "audio";
  if (contentType && isTextContentType(contentType)) return "text";
  if (needsSniff(name, contentType) && size !== undefined && size < SNIFF_MAX_BYTES) return "text";
  return "fallback";
}
