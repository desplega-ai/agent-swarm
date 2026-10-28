// Copying a drive file's contents to the clipboard (the file header's copy
// button and the file menu's "Copy contents"). Relative imports only, so
// `bun:test` can import it from the repo root.

import type { StatResult } from "../agent-fs/types";
import { fileExtension, getFileKind, looksLikeText, mediaType } from "./file-kinds";

/** Files above this size are not copied (the button offers a download). */
export const COPY_CONTENTS_MAX_BYTES = 1024 * 1024;

export const TOO_LARGE_TO_COPY = "Too large to copy";
export const CANT_COPY_TYPE = "Can't copy this file type";
export const CLIPBOARD_BLOCKED = "Could not copy. The browser blocked the clipboard.";

// Text types that the viewers do not name but that are still plain text.
const EXTRA_TEXT_TYPES = new Set(["application/yaml", "application/x-yaml", "application/toml"]);

/** Whether a file can be copied, and the reason when it cannot. */
export type CopyCheck = { copyable: true } | { copyable: false; reason: string };

/**
 * Decided from `stat` before any bytes load. A file copies when it is text
 * (what the text, markdown, and table viewers render, plus SVG and YAML) and
 * at most `COPY_CONTENTS_MAX_BYTES`.
 */
export function copyCheck(path: string, stat: Pick<StatResult, "size" | "contentType">): CopyCheck {
  const kind = getFileKind(path, stat.contentType, stat.size);
  const textLike =
    kind === "text" ||
    kind === "markdown" ||
    kind === "table" ||
    fileExtension(path) === "svg" ||
    EXTRA_TEXT_TYPES.has(mediaType(stat.contentType));
  if (!textLike) return { copyable: false, reason: CANT_COPY_TYPE };
  if (stat.size > COPY_CONTENTS_MAX_BYTES) return { copyable: false, reason: TOO_LARGE_TO_COPY };
  return { copyable: true };
}

/**
 * The loaded text, or a rejection when the bytes are binary after all (a
 * small file with no known extension opens as text until its bytes say so).
 */
export function textToCopy(text: string): string {
  if (!looksLikeText(text)) throw new Error(CANT_COPY_TYPE);
  return text;
}

/** The parts of the browser this needs, so tests can pass fakes. */
export interface ClipboardEnv {
  clipboard?: Pick<Clipboard, "write" | "writeText">;
  ClipboardItem?: typeof ClipboardItem;
}

function browserEnv(): ClipboardEnv {
  return {
    clipboard: typeof navigator === "undefined" ? undefined : navigator.clipboard,
    ClipboardItem: typeof ClipboardItem === "undefined" ? undefined : ClipboardItem,
  };
}

/**
 * Copy text that is still loading. Call it inside the click handler, before
 * any await: Safari drops the user gesture across an await, so the clipboard
 * write starts at once with a `ClipboardItem` whose text is a promise. Without
 * `ClipboardItem`, or when that write fails, it waits for the text and falls
 * back to `writeText`. Resolves to whether the copy worked; never rejects.
 */
export async function writeTextWhenReady(
  text: Promise<string>,
  env: ClipboardEnv = browserEnv(),
): Promise<boolean> {
  const { clipboard, ClipboardItem: Item } = env;
  if (!clipboard) return false;
  if (Item && clipboard.write) {
    try {
      await clipboard.write([
        new Item({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) }),
      ]);
      return true;
    } catch {
      // Falls back to writeText below.
    }
  }
  try {
    await clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}
