import { scrubSecrets } from "./secret-scrubber";

const EXPIRY = /delete\s+(on\s+)?\d{2}-\d{2}/i;

function trackedLines(markdown: string): string[] {
  const marker = "## Tracked Items";
  const start = markdown.lastIndexOf(marker);
  if (start < 0) return [];
  const lineEnd = markdown.indexOf("\n", start);
  if (lineEnd < 0) return [];
  // Stop at the next peer/parent section; subheadings may group tracked items.
  const section = markdown.slice(lineEnd + 1).split(/^#{1,2}\s/m)[0] ?? "";
  return section
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?/, ""))
    .filter((line) => line && !line.startsWith("#") && !/^[-*_]{3,}$/.test(line));
}

function title(line: string): string | undefined {
  return /^\*\*([^*]+)\*\*/.exec(line)?.[1];
}

// Deleting text anywhere in a legacy line is cleanup, not a new item.
function isShortening(old: string, next: string): boolean {
  let cursor = 0;
  for (const character of next) {
    const index = old.indexOf(character, cursor);
    if (index < 0) return false;
    cursor = index + character.length;
  }
  return true;
}

export class HeartbeatExpiryError extends Error {
  constructor(line: string) {
    super(
      scrubSecrets(
        `Update rejected for heartbeatMd: new tracked item requires DELETE <MM-DD> (or DELETE on <MM-DD>): ${line}`,
      ),
    );
    this.name = "HeartbeatExpiryError";
  }
}

/** Grandfather existing lines, but never let one old item cover two new ones. */
export function validateHeartbeatExpiry(currentValue: string, nextValue: string): void {
  const previous = trackedLines(currentValue);
  const incoming = trackedLines(nextValue);
  // Consume exact matches first so an unchanged item cannot sponsor a new item.
  const changed = incoming.filter((line) => {
    const index = previous.indexOf(line);
    if (index < 0) return true;
    previous.splice(index, 1);
    return false;
  });
  // Dated/pinned replacements also consume their old item before undated edits.
  // Otherwise dating one old item could accidentally authorize an undated copy.
  for (const line of changed) {
    if (!line.startsWith("📌") && !EXPIRY.test(line)) continue;
    const itemTitle = title(line.replace(/^📌\s*/, ""));
    const index = previous.findIndex(
      (old) => line.includes(old) || (itemTitle !== undefined && itemTitle === title(old)),
    );
    if (index >= 0) previous.splice(index, 1);
  }
  for (const line of changed) {
    if (line.startsWith("📌") || EXPIRY.test(line)) continue;
    const itemTitle = title(line);
    const index = previous.findIndex(
      (old) =>
        !old.startsWith("📌") &&
        !EXPIRY.test(old) &&
        (isShortening(old, line) || (itemTitle !== undefined && itemTitle === title(old))),
    );
    if (index < 0) throw new HeartbeatExpiryError(line);
    previous.splice(index, 1);
  }
}
