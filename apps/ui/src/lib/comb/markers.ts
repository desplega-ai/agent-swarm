// Comment markers shared by the comment rail (step-7), the mention picker
// (step-8), and "Send to swarm" (step-9).
//
// - `@swarm` in a comment body marks the comment for the swarm.
// - A reply that starts with `[comb:sent task=<uuid>]` records that the
//   comment went to the swarm as that task. The swarm service account writes
//   it (`src/comb/markers.ts` keeps the server copy of the pattern).

/** `@swarm` as its own word. `me@swarm.local` does not match. */
export const SWARM_MARKER_RE = /(^|\s)@swarm\b/i;

/** The machine-readable "sent" reply. Group 1 is the task id. */
export const SENT_MARKER_RE = /^\[comb:sent task=([0-9a-f-]{36})\]/;

export function hasSwarmMarker(body: string): boolean {
  return SWARM_MARKER_RE.test(body);
}

/** The task id of a "sent" reply, else null. */
export function sentTaskIdOf(reply: { body: string }): string | null {
  return SENT_MARKER_RE.exec(reply.body)?.[1] ?? null;
}

/** True when any reply of the thread is a "sent" reply. */
export function isSentToSwarm(thread: { replies: ReadonlyArray<{ body: string }> }): boolean {
  return thread.replies.some((reply) => sentTaskIdOf(reply) !== null);
}

export type BodySegment = { kind: "text"; text: string } | { kind: "swarm"; text: string };

/**
 * Split a comment body into plain text and `@swarm` tokens (same rule as
 * `SWARM_MARKER_RE`), so the thread renders each token as a chip. The
 * whitespace before a token stays in the text before it.
 */
export function splitSwarmMarkers(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  const re = new RegExp(SWARM_MARKER_RE.source, "gi");
  let last = 0;
  for (let match = re.exec(body); match; match = re.exec(body)) {
    const tokenStart = match.index + match[1].length;
    if (tokenStart > last) segments.push({ kind: "text", text: body.slice(last, tokenStart) });
    segments.push({ kind: "swarm", text: body.slice(tokenStart, re.lastIndex) });
    last = re.lastIndex;
  }
  if (last < body.length) segments.push({ kind: "text", text: body.slice(last) });
  return segments;
}
