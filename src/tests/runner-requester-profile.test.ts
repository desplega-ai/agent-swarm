import { describe, expect, test } from "bun:test";
import { buildRequesterProfilePrompt } from "../commands/runner";

describe("runner requester profile prompt", () => {
  test("omits requester profile when no role or notes are set", async () => {
    await expect(
      buildRequesterProfilePrompt({ name: "Taras", email: "t@example.com" }),
    ).resolves.toBe("");
  });

  test("formats requester role and free-text notes", async () => {
    const prompt = await buildRequesterProfilePrompt({
      name: "Taras",
      email: "t@example.com",
      role: "CEO",
      notes: "Lead with the answer; keep updates terse.",
    });

    expect(prompt).toContain("## Requester Profile");
    expect(prompt).toContain("This task was requested by Taras (CEO).");
    expect(prompt).toContain("Their stated notes for how you should respond and act:");
    expect(prompt).toContain("Lead with the answer; keep updates terse.");
    expect(prompt).toContain("where it doesn't conflict with correctness or your operating rules");
  });
});
