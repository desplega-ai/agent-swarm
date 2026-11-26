import { afterEach, describe, expect, test } from "bun:test";
import { configureDbResolver, resetDbResolver } from "../prompts/resolver";
import { renderSteeringDelivery } from "../prompts/steering-delivery";

afterEach(resetDbResolver);

describe("steering delivery sender", () => {
  test.each([
    "Taras (user)",
    "Lead (agent)",
    "system",
    "deleted-user (user)",
  ])("renders %s and preserves the acknowledgement marker", async (sender) => {
    const id = crypto.randomUUID();
    expect(await renderSteeringDelivery(id, "change course", sender)).toContain(
      `[steering ${id}] From ${sender}: change course`,
    );
  });

  test("sender is a template variable and whitespace is flattened", async () => {
    configureDbResolver(async () => ({
      template: { id: "custom", scope: "global", body: "{{sender}}: {{body}}" },
    }));
    expect(await renderSteeringDelivery("id", "body", "Taras\n(user)")).toBe("Taras (user): body");
  });

  test("falls back to the bare body on skipped, blank, and failing templates", async () => {
    for (const resolver of [
      async () => ({ skip: true as const }),
      async () => ({ template: { id: "blank", scope: "global", body: " " } }),
      async () => {
        throw new Error("unavailable");
      },
    ]) {
      configureDbResolver(resolver);
      expect(await renderSteeringDelivery("id", "body", "Taras (user)")).toBe("body");
    }
  });

  test("lists attached files with a fetch command each, inside the body", async () => {
    const id = crypto.randomUUID();
    const text = await renderSteeringDelivery(id, "see the screenshot", "Taras (user)", [
      { id: "att-1", taskId: "task-1", name: "image.png", mimeType: "image/png", sizeBytes: 10 },
      { id: "att-2", taskId: "task-0", name: "notes.txt" },
    ]);
    expect(text).toContain(`[steering ${id}] From Taras (user): see the screenshot`);
    expect(text).toContain("📎 Attached file(s), fetch directly:");
    expect(text).toContain("- image.png (image/png, 10 bytes): `curl");
    expect(text).toContain("$MCP_BASE_URL/api/fs/tasks/task-1/files/att-1/raw");
    // Each file names its own task (a message carried to a successor).
    expect(text).toContain("$MCP_BASE_URL/api/fs/tasks/task-0/files/att-2/raw");
    expect(text).toContain("- notes.txt: `curl");
  });

  test("the bare-body fallback keeps the file list", async () => {
    configureDbResolver(async () => ({ skip: true as const }));
    const text = await renderSteeringDelivery("id", "body", "Taras (user)", [
      { id: "a", taskId: "t", name: "x.png" },
    ]);
    expect(text).toStartWith("body\n\n📎 Attached file(s)");
  });

  test("no attachments renders exactly as before", async () => {
    expect(await renderSteeringDelivery("id", "body", "Taras (user)", [])).toBe(
      await renderSteeringDelivery("id", "body", "Taras (user)"),
    );
  });
});
