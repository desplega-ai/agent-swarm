import { describe, expect, test } from "bun:test";
import { buildAttachmentsSection } from "../commands/runner";

describe("buildAttachmentsSection", () => {
  test("returns empty string when there are no attachments", () => {
    expect(buildAttachmentsSection("task-1", undefined)).toBe("");
    expect(buildAttachmentsSection("task-1", null)).toBe("");
    expect(buildAttachmentsSection("task-1", [])).toBe("");
  });

  test("returns empty string when taskId is missing", () => {
    expect(buildAttachmentsSection(undefined, [{ id: "att-1", name: "photo.jpeg" }])).toBe("");
  });

  test("builds a one-shot curl recipe against the provider-agnostic raw route", () => {
    const section = buildAttachmentsSection("task-123", [
      { id: "att-1", name: "IMG_1357.jpeg", mimeType: "image/jpeg", sizeBytes: 2816227 },
    ]);

    expect(section).toContain("IMG_1357.jpeg");
    expect(section).toContain("image/jpeg, 2816227 bytes");
    expect(section).toContain(
      "$MCP_BASE_URL/api/fs/tasks/task-123/files/att-1/raw\" --create-dirs -o '/tmp/attachments/att-1/IMG_1357.jpeg'",
    );
    // No org/drive discovery should be required — the whole point of the fix.
    expect(section).not.toContain("agent-fs");
    expect(section).toContain("X-Agent-ID: $AGENT_ID");
    expect(section).toContain("Authorization: Bearer ");
    expect(section).toContain("AGENT_SWARM_API_KEY:-$API_KEY");
  });

  test("handles multiple attachments, one line each", () => {
    const section = buildAttachmentsSection("task-123", [
      { id: "att-1", name: "a.png" },
      { id: "att-2", name: "b.pdf" },
    ]);

    const lines = section.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("a.png");
    expect(lines[1]).toContain("b.pdf");
  });

  test("quotes the output path so names from users can't break the command", () => {
    const section = buildAttachmentsSection("task-123", [
      { id: "att-1", name: "Screenshot 2026-09-11 at 1.55 PM.png" },
      { id: "att-2", name: "it's ../../etc/passwd" },
    ]);

    expect(section).toContain("-o '/tmp/attachments/att-1/Screenshot 2026-09-11 at 1.55 PM.png'");
    expect(section).toContain("-o '/tmp/attachments/att-2/it'\\''s .._.._etc_passwd'");
  });

  test("gives every attachment its own download path, even when names repeat", () => {
    const section = buildAttachmentsSection("task-123", [
      { id: "att-1", name: "image.png" },
      { id: "att-2", name: "image.png" },
    ]);

    expect(section).toContain("-o '/tmp/attachments/att-1/image.png'");
    expect(section).toContain("-o '/tmp/attachments/att-2/image.png'");
  });

  test("skips malformed attachment entries without throwing", () => {
    const section = buildAttachmentsSection("task-123", [
      { id: "att-1" }, // missing name — id used as fallback name
      { name: "no-id.txt" }, // missing id — dropped
      "not-an-object",
      null,
    ]);

    expect(section).toContain("att-1");
    expect(section).not.toContain("no-id.txt");
  });
});
