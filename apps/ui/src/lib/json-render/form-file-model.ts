/**
 * Pure logic for Form `kind: "file"` fields: upload names, the `$form` value
 * shape, and the submit step that uploads pending files before the chain.
 */

import type { FormField } from "./catalog";

/** Picked local files waiting for submit, by field name. */
export type PendingFiles = Record<string, File[]>;

/** Uploads one file to `path`; resolves with the stored path. */
export type UploadFn = (path: string, file: File) => Promise<string>;

/** Characters outside `[A-Za-z0-9._-]` become `-`; never empty, at most 120 chars. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|-+$/g, "");
  return cleaned.slice(-120) || "file";
}

/** `20261106T121500123Z`: sortable, and unique per millisecond. */
export function uploadTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "");
}

/**
 * `<dir>/<timestamp>-<sanitized name>`. Several files in one submit share the
 * timestamp, so each gets its position too.
 */
export function fileUploadPath(dir: string, name: string, now: Date, index = 0, count = 1): string {
  const folder = dir.replace(/\/+$/, "");
  const stamp = count > 1 ? `${uploadTimestamp(now)}-${index + 1}` : uploadTimestamp(now);
  return `${folder}/${stamp}-${sanitizeFileName(name)}`;
}

/** The stored paths of a file field: its state value as a list. */
export function filePaths(value: unknown): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/** `$form.<name>`: the path, or an array of paths with `multiple`. */
export function fileFieldValue(field: FormField, paths: readonly string[]): unknown {
  if (field.multiple === true) return paths.length > 0 ? [...paths] : undefined;
  return paths[0];
}

export function isFileField(field: FormField): boolean {
  return field.kind === "file";
}

export function allowsUpload(field: FormField): boolean {
  return field.source !== "pick";
}

export function allowsPick(field: FormField): boolean {
  return field.source === "pick" || field.source === "both";
}

export type FileFieldResolution =
  | { ok: true; values: Record<string, unknown>; writes: Record<string, unknown> }
  | { ok: false; error: string; writes: Record<string, unknown> };

/**
 * The submit step for file fields, run BEFORE the action chain: checks
 * required fields, uploads every pending file (create-only, one at a time),
 * and returns each field's `$form` value plus the state writes that replace
 * its pending files with their stored paths. A failure returns the error and
 * the chain never runs; the form keeps its values, and `writes` holds only
 * the fields whose uploads all landed, so a retry does not upload them again.
 * shortcut: a field that fails midway re-uploads its earlier files on retry; track per-file paths if that duplicates in practice.
 * `upload` is null when agent-fs is not connected.
 */
export async function resolveFileFields(input: {
  fields: readonly FormField[];
  read: (name: string) => unknown;
  pending: PendingFiles;
  upload: UploadFn | null;
  now?: Date;
}): Promise<FileFieldResolution> {
  const now = input.now ?? new Date();
  const values: Record<string, unknown> = {};
  const writes: Record<string, unknown> = {};
  const queued: { field: FormField; stored: string[]; files: File[] }[] = [];
  for (const field of input.fields) {
    if (!isFileField(field)) continue;
    const stored = filePaths(input.read(field.name));
    const files = input.pending[field.name] ?? [];
    if (field.required && stored.length + files.length === 0) {
      return { ok: false, error: `${field.label ?? field.name} is required`, writes };
    }
    if (files.length > 0 && !field.dir) {
      return { ok: false, error: `${field.label ?? field.name} has no upload folder`, writes };
    }
    queued.push({ field, stored, files });
  }
  if (queued.some((entry) => entry.files.length > 0) && !input.upload) {
    return { ok: false, error: "Connect agent-fs to upload files", writes };
  }
  for (const { field, stored, files } of queued) {
    const uploaded: string[] = [];
    for (const [index, file] of files.entries()) {
      const path = fileUploadPath(field.dir as string, file.name, now, index, files.length);
      try {
        uploaded.push(await (input.upload as UploadFn)(path, file));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `Could not upload ${file.name}: ${reason}`, writes };
      }
    }
    const paths =
      field.multiple === true ? [...stored, ...uploaded] : uploaded.length > 0 ? uploaded : stored;
    const value = fileFieldValue(field, paths);
    if (value !== undefined) values[field.name] = value;
    if (uploaded.length > 0) writes[field.name] = value;
  }
  return { ok: true, values, writes };
}
