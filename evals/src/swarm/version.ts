/**
 * Version-string sanitation (v5 spec §5). CLI stdout captured from sandboxes
 * carries ANSI escape sequences (e.g. the cursor-restore CSI `ESC[?25h` that
 * `agent-swarm version` emits on exit) — strip them BEFORE extracting a
 * version, or the dirty string ends up persisted in sandbox_json.
 *
 * Pure module on purpose: imported by sandbox.ts (write path) and by the
 * analytics aggregation (read path, re-cleans historical dirty rows).
 */

// CSI: ESC [ params(0-9;?) intermediates(SP-/) final(@-~) — covers ESC[?25h, colors, …
// OSC: ESC ] … terminated by BEL or ST (ESC \)
// 2-char: ESC @–_ (RIS, IND, NEL, …)
const ANSI_RE = new RegExp(
  [
    "\\u001b\\[[0-9;?]*[ -/]*[@-~]", // CSI sequences
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?", // OSC sequences
    "\\u001b[@-_]", // bare 2-char escapes
  ].join("|"),
  "g",
);

// Remaining C0 control chars + DEL (newlines included — version output is one logical line).
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the whole point
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/** Strip ANSI escape sequences: CSI (incl. private modes like ESC[?25h), OSC, 2-char ESC. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

const SEMVER_RE = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

/**
 * Clean a raw captured version string: stripAnsi → control chars to spaces →
 * trim → first `vX.Y.Z[-pre]` capture. When no semver-ish token exists the
 * cleaned text is kept (clipped to 64 chars) rather than losing the signal;
 * empty/null input → null.
 */
export function cleanVersion(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = stripAnsi(raw).replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  const captured = cleaned.match(SEMVER_RE)?.[1];
  if (captured !== undefined) return captured;
  return cleaned.slice(0, 64);
}
