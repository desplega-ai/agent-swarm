import { describe, expect, test } from "bun:test";
import {
  type AnchorDiffChange,
  anchorNeedsDiff,
  commentAnchorInput,
  resolveAnchor,
  sourceTextSpace,
} from "./comment-anchor";

// Smoke test for the verbatim copy of live/'s anchoring logic.

const V1 = "# QA\n\nFirst paragraph.\n\nSecond paragraph.\n";
const COMMENT = {
  quote: { exact: "Second paragraph.", prefix: "First paragraph.\n\n", suffix: "\n" },
  lineStart: 5,
  lineEnd: 5,
  fileVersion: 1,
};

function resolveAt(text: string, currentVersion: number, changes?: AnchorDiffChange[]) {
  const entry = commentAnchorInput(COMMENT, currentVersion);
  if (!entry) throw new Error("expected an anchored comment");
  return resolveAnchor(sourceTextSpace(text), { ...entry.input, changes });
}

describe("comment-anchor (copied from live/)", () => {
  test("resolves the exact quote in the version it was made on", () => {
    const r = resolveAt(V1, 1);
    expect(r.status).toBe("anchored");
    expect(r.method).toBe("quote");
    expect(V1.slice(r.start, r.end)).toBe("Second paragraph.");
    expect(r.lineStart).toBe(5);
    expect(anchorNeedsDiff(r)).toBe(false);
  });

  test("follows the quote when lines are inserted above it", () => {
    const v2 = `Intro A\nIntro B\n${V1}`;
    const r = resolveAt(v2, 2);
    expect(r.status).toBe("anchored");
    expect(v2.slice(r.start, r.end)).toBe("Second paragraph.");
    expect(r.lineStart).toBe(7);
  });

  test("moves through the diff when the quoted text itself changed", () => {
    const v2 = "Intro A\nIntro B\n# QA\n\nFirst paragraph.\n\nSecond paragraph, revised.\n";
    const changes: AnchorDiffChange[] = [
      { type: "add", newLine: 1 },
      { type: "add", newLine: 2 },
      { type: "context", oldLine: 1, newLine: 3 },
      { type: "context", oldLine: 2, newLine: 4 },
      { type: "context", oldLine: 3, newLine: 5 },
      { type: "context", oldLine: 4, newLine: 6 },
      { type: "remove", oldLine: 5 },
      { type: "add", newLine: 7 },
    ];
    // Without the diff the quote alone cannot place it.
    expect(anchorNeedsDiff(resolveAt(v2, 2))).toBe(true);
    const r = resolveAt(v2, 2, changes);
    expect(r.status).toBe("moved");
    expect(r.method).toBe("lines");
    expect(r.lineStart).toBe(7);
    expect(v2.slice(r.start, r.end)).toBe("Second paragraph, revised.");
  });

  test("is lost when the passage was deleted", () => {
    const v2 = "# QA\n\nFirst paragraph.\n";
    const changes: AnchorDiffChange[] = [
      { type: "context", oldLine: 1, newLine: 1 },
      { type: "context", oldLine: 2, newLine: 2 },
      { type: "context", oldLine: 3, newLine: 3 },
      { type: "remove", oldLine: 4 },
      { type: "remove", oldLine: 5 },
    ];
    expect(resolveAt(v2, 2, changes)).toEqual({ status: "lost" });
  });

  test("a file-level comment has nothing to anchor", () => {
    expect(commentAnchorInput({ fileVersion: 1 }, 2)).toBeNull();
  });
});
