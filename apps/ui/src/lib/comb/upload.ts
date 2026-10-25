// Comb uploads: target paths, "Keep both" names, folder drops, and the upload
// queue. Pure, with relative imports only, so the root test runner covers it.
// The queue follows agent-fs `live/src/stores/upload.ts` (v0.18.5): at most 3
// uploads at once, create-only, and a name clash waits for the person.

import { baseName, parentFolder } from "./paths";

/** agent-fs's own default upload limit, for a server that does not report one in `/health`. */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_CONCURRENT_UPLOADS = 3;
/** The version message of an uploaded file. */
export const UPLOAD_MESSAGE = "Uploaded from Comb";

/** The server's limit from `/health`, or agent-fs's default. */
export function uploadLimitBytes(maxUploadBytes: number | null | undefined): number {
  return typeof maxUploadBytes === "number" &&
    Number.isSafeInteger(maxUploadBytes) &&
    maxUploadBytes > 0
    ? maxUploadBytes
    : DEFAULT_MAX_UPLOAD_BYTES;
}

/** "50 MB" for the limit text. */
export function formatLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/**
 * The drive path of a file dropped into `folder` ("/docs/"). `relativePath`
 * keeps a dropped folder's structure ("shots/a.png"). Empty, "." and ".."
 * segments are dropped, so a name can never leave the folder.
 */
export function uploadTargetPath(folder: string, relativePath: string): string {
  const segments = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  const base = folder.endsWith("/") ? folder : `${folder}/`;
  return `${base}${segments.join("/")}`;
}

/** A trailing " (n)" before the extension, from an earlier "Keep both". */
const COUNTER_RE = /^(.*) \((\d+)\)$/;

/**
 * The first free name for "Keep both": "photo.png" becomes "photo (1).png",
 * then "photo (2).png". A name that already ends with a counter counts on
 * ("photo (1).png" becomes "photo (2).png"). The extension is the part after
 * the last dot. A name with no dot, or only a leading dot (".env"), has none.
 */
export function keepBothName(name: string, taken: ReadonlySet<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const counted = COUNTER_RE.exec(stem);
  const root = counted ? (counted[1] as string) : stem;
  let n = counted ? Number(counted[2]) + 1 : 1;
  while (taken.has(`${root} (${n})${ext}`)) n++;
  return `${root} (${n})${ext}`;
}

/** The "Keep both" path of `path`, given the names taken in its folder. */
export function keepBothPath(path: string, taken: ReadonlySet<string>): string {
  return `${parentFolder(path)}${keepBothName(baseName(path), taken)}`;
}

// --- Folder drops ---------------------------------------------------------------

/** The parts of the File and Directory Entries API that a drop needs. */
export interface DropEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (onFile: (file: File) => void, onError: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      onEntries: (entries: DropEntry[]) => void,
      onError: (error: unknown) => void,
    ) => void;
  };
}

/** The parts of a `DataTransferItem` that a drop reads. */
export interface DropItem {
  kind: string;
  webkitGetAsEntry: () => unknown;
  getAsFile: () => File | null;
}

/**
 * The file entries and files of a drop, index by index. Only `file` items
 * count: a drag from a web page also carries `string` items (a URL, HTML),
 * and they must not shift the files against their entries.
 */
export function dropSources(items: ArrayLike<DropItem>): {
  entries: Array<DropEntry | null>;
  files: Array<File | null>;
} {
  const fileItems = Array.from(items).filter((item) => item.kind === "file");
  return {
    entries: fileItems.map((item) => item.webkitGetAsEntry() as DropEntry | null),
    files: fileItems.map((item) => item.getAsFile()),
  };
}

export interface UploadInput {
  file: File;
  /** Path relative to the folder the files were dropped on ("shots/a.png"). */
  relativePath: string;
}

/** Most files one drop reads, so a dropped home folder cannot hang the tab. */
export const MAX_DROP_FILES = 1000;

async function readEntry(entry: DropEntry, prefix: string, out: UploadInput[]): Promise<void> {
  if (out.length >= MAX_DROP_FILES) return;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file?.(resolve, reject));
    out.push({ file, relativePath: `${prefix}${entry.name}` });
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  const reader = entry.createReader();
  // `readEntries` answers in batches (100 in Chrome) until it answers none.
  for (;;) {
    const batch = await new Promise<DropEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return;
    for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, out);
  }
}

/**
 * The files of a drop, folders included (their structure kept in
 * `relativePath`). `entries` comes from `webkitGetAsEntry()` on each item;
 * read it inside the drop event, because the list empties after it. A null
 * entry falls back to the plain file at the same index.
 */
export async function filesFromDrop(
  entries: ReadonlyArray<DropEntry | null>,
  files: ReadonlyArray<File | null>,
): Promise<UploadInput[]> {
  const out: UploadInput[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry) {
      await readEntry(entry, "", out);
    } else {
      const file = files[index];
      if (file) out.push({ file, relativePath: file.name });
    }
  }
  return out.slice(0, MAX_DROP_FILES);
}

// --- Queue --------------------------------------------------------------------

export type UploadStatus =
  | "queued"
  | "uploading"
  | "done"
  /** A file already has this name. Waits for Keep both or Skip. */
  | "conflict"
  | "error"
  /** Over the size limit. Never sent. */
  | "rejected"
  | "skipped";

const FINISHED: ReadonlySet<UploadStatus> = new Set(["done", "error", "rejected", "skipped"]);

export function isFinished(status: UploadStatus): boolean {
  return FINISHED.has(status);
}

/** One upload. `put` sends it (create-only) and resolves to the new version. */
export type PutFn = (
  path: string,
  file: File,
  opts: { signal: AbortSignal; onProgress: (fraction: number) => void },
) => Promise<{ version: number }>;

/** The drive an upload goes to. */
export interface UploadDrive {
  orgId: string;
  driveId: string;
}

export interface UploadItem {
  id: number;
  drive: UploadDrive;
  /** Drive path the file is sent to (changes on Keep both). */
  path: string;
  file: File;
  status: UploadStatus;
  /** 0..1 */
  progress: number;
  error?: string;
  version?: number;
  put: PutFn;
}

export interface UploadSummary {
  done: number;
  failed: number;
}

export interface UploadQueueOptions {
  /** True when an error means "the name is taken" (agent-fs answers 409). */
  isConflict: (error: unknown) => boolean;
  /** True when the upload was cancelled. */
  isAbort: (error: unknown) => boolean;
  /** Once nothing runs or waits for a decision. */
  onDrained?: (summary: UploadSummary) => void;
}

/**
 * The upload queue: create-only uploads, `MAX_CONCURRENT_UPLOADS` at a time.
 * A clash parks the item in `conflict` until `keepBoth` (a new name) or
 * `skip`. Subscribe with `subscribe`, read with `getItems` (a new array on
 * each change, for `useSyncExternalStore`).
 */
export class UploadQueue {
  private items: UploadItem[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly controllers = new Map<number, AbortController>();
  private batch: UploadSummary = { done: 0, failed: 0 };
  private nextId = 1;
  private readonly options: UploadQueueOptions;

  constructor(options: UploadQueueOptions) {
    this.options = options;
  }

  getItems = (): UploadItem[] => this.items;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private update(id: number, patch: Partial<UploadItem>): void {
    this.items = this.items.map((item) => (item.id === id ? { ...item, ...patch } : item));
    this.emit();
  }

  /** Queue files for `paths` on `drive`. A file over `maxBytes` is rejected before it is sent. */
  enqueue(
    drive: UploadDrive,
    files: ReadonlyArray<{ file: File; path: string }>,
    put: PutFn,
    maxBytes: number,
  ): void {
    const added: UploadItem[] = files.map(({ file, path }) => {
      const tooBig = file.size > maxBytes;
      return {
        id: this.nextId++,
        drive,
        path,
        file,
        status: tooBig ? "rejected" : "queued",
        progress: 0,
        error: tooBig ? `Larger than ${formatLimit(maxBytes)}` : undefined,
        put,
      };
    });
    this.items = [...this.items, ...added];
    this.emit();
    this.pump();
    this.summarizeIfDrained();
  }

  private statusOf(id: number): UploadStatus | undefined {
    return this.items.find((entry) => entry.id === id)?.status;
  }

  /**
   * Send a clashing file again under `path` (the next free name). Only a
   * `conflict` item moves: a second click, or a Skip that landed first, wins.
   */
  keepBoth(id: number, path: string): void {
    if (this.statusOf(id) !== "conflict") return;
    this.update(id, { status: "queued", path, progress: 0, error: undefined });
    this.pump();
  }

  /** Leave out a waiting file (a clash, or one not started yet). */
  skip(id: number): void {
    const status = this.statusOf(id);
    if (status !== "conflict" && status !== "queued") return;
    this.update(id, { status: "skipped" });
    this.summarizeIfDrained();
  }

  cancel(id: number): void {
    if (this.statusOf(id) === "uploading") this.controllers.get(id)?.abort();
    else this.skip(id);
  }

  /** Drop finished rows from the list. */
  clearFinished(): void {
    this.items = this.items.filter((item) => !isFinished(item.status));
    this.emit();
  }

  private pump(): void {
    let active = this.items.filter((item) => item.status === "uploading").length;
    for (const item of this.items) {
      if (active >= MAX_CONCURRENT_UPLOADS) break;
      if (item.status !== "queued") continue;
      active++;
      void this.run(item.id);
    }
  }

  private async run(id: number): Promise<void> {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.update(id, { status: "uploading", progress: 0 });
    try {
      const result = await item.put(item.path, item.file, {
        signal: controller.signal,
        onProgress: (fraction) => this.update(id, { progress: fraction }),
      });
      this.update(id, { status: "done", progress: 1, version: result.version });
      this.batch.done++;
    } catch (error) {
      if (this.options.isConflict(error)) {
        this.update(id, { status: "conflict", progress: 0 });
      } else if (this.options.isAbort(error)) {
        this.update(id, { status: "skipped" });
      } else {
        const message = error instanceof Error && error.message ? error.message : "Upload failed";
        this.update(id, { status: "error", error: message });
        this.batch.failed++;
      }
    } finally {
      this.controllers.delete(id);
      this.pump();
      this.summarizeIfDrained();
    }
  }

  /** One summary per batch, once nothing is in flight and no clash waits. */
  private summarizeIfDrained(): void {
    const pending = this.items.some(
      (item) =>
        item.status === "queued" || item.status === "uploading" || item.status === "conflict",
    );
    if (pending) return;
    const summary = this.batch;
    if (summary.done === 0 && summary.failed === 0) return;
    this.batch = { done: 0, failed: 0 };
    this.options.onDrained?.(summary);
  }
}
