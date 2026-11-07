/** Shared by the browser overlay (`src/dev/dev-notes.tsx`) and the node store. No node imports here. */
export type DevNoteStatus = "open" | "done";

export interface DevNote {
  id: string;
  /** Short number shown on the pin, unique per file. */
  n: number;
  createdAt: string;
  updatedAt: string;
  status: DevNoteStatus;
  /** `location.pathname + location.search` when the note was left. */
  path: string;
  viewport: { width: number; height: number };
  theme: "dark" | "light";
  /** CSS selector that finds the element again. */
  selector: string;
  /** Components that rendered the element (React owner chain), nearest first, e.g. `["StatusBadge", "StatusCell", ...]`. */
  components: string[];
  tag: string;
  /** Visible text or aria-label of the element, cut to 160 characters. */
  text: string;
  /** Click point inside the element, as a fraction of its width and height. */
  anchor: { x: number; y: number };
  comment: string;
  /** What the agent did about the note. Shown under the comment in the panel. */
  reply?: string;
}

export type NewDevNote = Omit<DevNote, "id" | "n" | "createdAt" | "updatedAt" | "status">;
export type DevNotePatch = Partial<Pick<DevNote, "status" | "comment" | "reply">>;
