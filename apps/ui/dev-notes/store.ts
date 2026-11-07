import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DevNote, DevNotePatch, NewDevNote } from "./types";

export type { DevNote, DevNotePatch, NewDevNote } from "./types";

/**
 * File store for dev notes: review comments left on the running dashboard
 * (`src/dev/dev-notes.tsx`). The Vite plugin (`./vite-plugin.ts`) and the
 * agent CLI (`./cli.ts`) both read and write this one JSON file.
 */
export function resolveNotesFile(): string {
  const fromEnv = process.env.DEV_NOTES_FILE?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.resolve(__dirname, "../.dev-notes/notes.json");
}

export function readNotes(file: string): DevNote[] {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DevNote[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function writeNotes(file: string, notes: DevNote[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(notes, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function addNote(file: string, input: NewDevNote): DevNote {
  const notes = readNotes(file);
  const now = new Date().toISOString();
  const note: DevNote = {
    ...input,
    id: randomUUID().slice(0, 8),
    n: notes.reduce((max, note) => Math.max(max, note.n), 0) + 1,
    createdAt: now,
    updatedAt: now,
    status: "open",
  };
  writeNotes(file, [...notes, note]);
  return note;
}

/** Finds a note by id, or by its pin number (`7` or `#7`). */
export function findNote(notes: DevNote[], ref: string): DevNote | undefined {
  const n = Number(ref.replace(/^#/, ""));
  return notes.find((note) => note.id === ref || (Number.isInteger(n) && note.n === n));
}

export function updateNote(file: string, ref: string, patch: DevNotePatch): DevNote | null {
  const notes = readNotes(file);
  const note = findNote(notes, ref);
  if (!note) return null;
  // A missing field keeps its value. A spread of `{ status: undefined }` would clear it.
  const set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const next: DevNote = { ...note, ...set, updatedAt: new Date().toISOString() };
  writeNotes(
    file,
    notes.map((item) => (item.id === note.id ? next : item)),
  );
  return next;
}

export function removeNote(file: string, ref: string): boolean {
  const notes = readNotes(file);
  const note = findNote(notes, ref);
  if (!note) return false;
  writeNotes(
    file,
    notes.filter((item) => item.id !== note.id),
  );
  return true;
}
