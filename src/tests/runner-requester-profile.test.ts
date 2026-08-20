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

  test("renders structured comms preferences alongside role and notes", async () => {
    const prompt = await buildRequesterProfilePrompt({
      name: "Taras",
      role: "CEO",
      notes: "Keep updates terse.",
      comms: { tone: "casual", language: "Ukrainian", verbosity: "terse" },
    });

    expect(prompt).toContain(
      "Their communication preferences: tone: casual, language: Ukrainian, verbosity: terse.",
    );
    expect(prompt).toContain("Their stated notes for how you should respond and act:");
  });

  test("fires when only comms preferences are set", async () => {
    const prompt = await buildRequesterProfilePrompt({
      name: "Taras",
      comms: { language: "Ukrainian" },
    });

    expect(prompt).toContain("## Requester Profile");
    expect(prompt).toContain("This task was requested by Taras.");
    expect(prompt).toContain("Their communication preferences: language: Ukrainian.");
    expect(prompt).not.toContain("Their stated notes");
  });

  test("hints that learned preferences should be persisted via manage-user", async () => {
    const prompt = await buildRequesterProfilePrompt({ name: "Taras", role: "CEO" });

    expect(prompt).toContain(
      "the lead updates `comms` (tone, language, verbosity) via `manage-user`",
    );
  });

  test("ignores empty comms object", async () => {
    await expect(buildRequesterProfilePrompt({ name: "Taras", comms: {} })).resolves.toBe("");
  });
});
