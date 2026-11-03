#!/usr/bin/env bun
/**
 * Agent side of dev notes. Run from apps/ui:
 *
 *   bun dev-notes/cli.ts list [--all]        open notes (or all notes)
 *   bun dev-notes/cli.ts done <n> [reply]     mark note #n done, with an optional reply
 *   bun dev-notes/cli.ts reply <n> <reply>    answer a note and leave it open
 *   bun dev-notes/cli.ts reopen <n>
 *   bun dev-notes/cli.ts rm <n>
 *
 * Open dashboard tabs pick up every change at once (the Vite plugin watches the file).
 */
import {
  type DevNote,
  findNote,
  readNotes,
  removeNote,
  resolveNotesFile,
  updateNote,
} from "./store";

const file = resolveNotesFile();
const [command = "list", ref, ...rest] = process.argv.slice(2);
const text = rest.join(" ").trim();

function format(note: DevNote): string {
  const where = [note.tag, note.text && JSON.stringify(note.text)].filter(Boolean).join(" ");
  const lines = [
    `#${note.n} [${note.status}] ${note.path}  (${note.viewport.width}x${note.viewport.height}, ${note.theme}, ${note.createdAt.slice(0, 16).replace("T", " ")} UTC)`,
    `  element:    ${where}`,
    `  components: ${note.components.join(" < ") || "(none found)"}`,
    `  selector:   ${note.selector}`,
    `  comment:    ${note.comment.replace(/\n/g, "\n              ")}`,
  ];
  if (note.reply) lines.push(`  reply:      ${note.reply.replace(/\n/g, "\n              ")}`);
  return lines.join("\n");
}

function requireNote(): DevNote {
  const note = ref ? findNote(readNotes(file), ref) : undefined;
  if (!note) {
    console.error(`No note "${ref ?? ""}" in ${file}`);
    process.exit(1);
  }
  return note;
}

switch (command) {
  case "list": {
    const all = ref === "--all";
    const notes = readNotes(file).filter((note) => all || note.status === "open");
    console.log(
      notes.length ? notes.map(format).join("\n\n") : `No ${all ? "" : "open "}notes in ${file}`,
    );
    break;
  }
  case "done":
    console.log(
      format(
        updateNote(file, requireNote().id, { status: "done", reply: text || undefined }) as DevNote,
      ),
    );
    break;
  case "reply":
    if (!text) {
      console.error("Usage: reply <n> <text>");
      process.exit(1);
    }
    console.log(format(updateNote(file, requireNote().id, { reply: text }) as DevNote));
    break;
  case "reopen":
    console.log(format(updateNote(file, requireNote().id, { status: "open" }) as DevNote));
    break;
  case "rm":
    removeNote(file, requireNote().id);
    console.log(`Deleted note ${ref}`);
    break;
  default:
    console.error(`Unknown command "${command}". Use list, done, reply, reopen or rm.`);
    process.exit(1);
}
