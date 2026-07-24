/**
 * Glob matcher for dot-separated event names.
 *
 * Pattern language (kept deliberately tiny):
 *   - `*`  matches exactly one segment (no dots)
 *   - `**` matches one or more remaining segments (only meaningful as the
 *     last segment)
 *   - anything else is matched literally, per segment
 *
 * Examples: "task.*" matches "task.completed" but not "task.a.b";
 * "github.**" matches "github.pull_request.opened"; "*" matches "ping" only.
 */
export function matchesEventPattern(pattern: string, eventName: string): boolean {
  if (pattern === eventName) return true;
  const patternSegments = pattern.split(".");
  const nameSegments = eventName.split(".");

  for (let i = 0; i < patternSegments.length; i++) {
    const seg = patternSegments[i];
    if (seg === "**") {
      // `**` must consume at least one segment.
      return i === patternSegments.length - 1 && nameSegments.length > i;
    }
    if (i >= nameSegments.length) return false;
    if (seg !== "*" && seg !== nameSegments[i]) return false;
  }
  return patternSegments.length === nameSegments.length;
}

/** Validate a pattern at subscription-creation time. */
export function validateEventPattern(pattern: string): string | null {
  if (!pattern) return "eventPattern must be non-empty";
  const segments = pattern.split(".");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) return "eventPattern must not contain empty segments";
    if (seg === "**" && i !== segments.length - 1) {
      return "'**' is only allowed as the last segment";
    }
    if (seg.includes("*") && seg !== "*" && seg !== "**") {
      return `invalid segment '${seg}' — '*' must stand alone in a segment`;
    }
  }
  return null;
}
