import { describe, expect, test } from "bun:test";
import { type HarnessCatalogSections, harnessModelMismatch } from "./index.ts";

const catalog: HarnessCatalogSections = {
  anthropic: {
    models: {
      "claude-opus-5-5": { release_date: "2026-08-01" },
      "claude-sonnet-5": { release_date: "2026-06-01" },
      "claude-haiku-4-5": { release_date: "2025-10-01" },
    },
  },
  openai: {
    models: {
      "gpt-6-luna": { release_date: "2026-09-01", reasoning: true },
      "gpt-5.6-sol": { release_date: "2026-05-01", reasoning: true },
      "gpt-5.6-terra": { release_date: "2026-05-01", reasoning: true },
      "gpt-5.6-luna": { release_date: "2026-05-01", reasoning: true },
      "gpt-5-nano": { release_date: "2025-08-01", reasoning: true },
    },
  },
  openrouter: {
    models: { "anthropic/claude-opus-5.5": { release_date: "2026-08-01" } },
  },
};

describe("harnessModelMismatch", () => {
  test("claude-opus-5-5 on codex fails and lists codex models", () => {
    const error = harnessModelMismatch("claude-opus-5-5", "codex", catalog, {
      agentName: "Reviewer 1",
      agentId: "a3b9cca2-1b37-9078-b000-000000000000",
    });
    expect(error).toContain("does not run on the codex harness");
    expect(error).toContain('of agent "Reviewer 1" (a3b9cca2-1b37-9078-b000-000000000000)');
    expect(error).toContain("gpt-");
    expect(error).toContain("Use modelTier (smol, regular, smart, ultra)");
  });

  test("gpt-5.6-sol on claude fails", () => {
    expect(harnessModelMismatch("gpt-5.6-sol", "claude", catalog)).toContain(
      "does not run on the claude harness",
    );
  });

  test("opus on claude passes (shortname)", () => {
    expect(harnessModelMismatch("opus", "claude", catalog)).toBeNull();
  });

  test("opus on codex passes (unknown to every section, rule 9)", () => {
    expect(harnessModelMismatch("opus", "codex", catalog)).toBeNull();
  });

  test("claude-opus-5-5[1m] on claude passes", () => {
    expect(harnessModelMismatch("claude-opus-5-5[1m]", "claude", catalog)).toBeNull();
  });

  test("latest:anthropic/opus on codex fails", () => {
    expect(harnessModelMismatch("latest:anthropic/opus", "codex", catalog)).toContain(
      "does not run on the codex harness",
    );
  });

  test("latest:openai/sol on codex passes", () => {
    expect(harnessModelMismatch("latest:openai/sol", "codex", catalog)).toBeNull();
  });

  test("openrouter/anthropic/claude-opus-5.5 on claude fails", () => {
    expect(
      harnessModelMismatch("openrouter/anthropic/claude-opus-5.5", "claude", catalog),
    ).toContain("does not run on the claude harness");
  });

  test("anthropic/claude-opus-5-5 on claude passes (own section prefix)", () => {
    expect(harnessModelMismatch("anthropic/claude-opus-5-5", "claude-managed", catalog)).toBeNull();
  });

  test("an uncatalogued id in the harness's own namespace passes; foreign and known-unsupported ids fail", () => {
    expect(harnessModelMismatch("openai/private-deployment-1", "codex", catalog)).toBeNull();
    expect(harnessModelMismatch("anthropic/claude-private-1", "claude", catalog)).toBeNull();
    expect(harnessModelMismatch("openai/gpt-5-nano", "codex", catalog)).toContain(
      "does not run on the codex harness",
    );
    expect(harnessModelMismatch("openai/claude-opus-5-5", "codex", catalog)).toContain(
      "does not run on the codex harness",
    );
    expect(harnessModelMismatch("anthropic/private-deployment-1", "codex", catalog)).toContain(
      "does not run on the codex harness",
    );
  });

  test("gpt-5-nano on codex fails (own section, excluded SKU)", () => {
    expect(harnessModelMismatch("gpt-5-nano", "codex", catalog)).toContain(
      "does not run on the codex harness",
    );
  });

  test("vendor-private-1 on codex passes (unknown everywhere)", () => {
    expect(harnessModelMismatch("vendor-private-1", "codex", catalog)).toBeNull();
  });

  test("any id on a free-form or unpinned harness passes", () => {
    for (const harness of ["pi", "devin", "acp", "dsh", "opencode", null, undefined]) {
      expect(harnessModelMismatch("claude-opus-5-5", harness, catalog)).toBeNull();
      expect(harnessModelMismatch("gpt-5.6-sol", harness, catalog)).toBeNull();
    }
  });

  test("the examples list has at most 8 ids and ends with ' and N more'", () => {
    const many: Record<string, { release_date: string; reasoning: boolean }> = {};
    for (let i = 0; i < 11; i++)
      many[`gpt-5.${i}-sol`] = { release_date: `2026-01-${10 + i}`, reasoning: true };
    const error = harnessModelMismatch("claude-opus-5-5", "codex", {
      ...catalog,
      openai: { models: many },
    });
    const examples = /for example: (.*?)\. Use modelTier/.exec(error ?? "")?.[1] ?? "";
    expect(examples.endsWith(" and 3 more")).toBe(true);
    expect(examples.replace(/ and 3 more$/, "").split(", ")).toHaveLength(8);
  });

  test("a small section lists every id with no suffix", () => {
    const error = harnessModelMismatch("gpt-6-luna", "claude", catalog) ?? "";
    expect(error).toContain("for example: claude-opus-5-5, claude-sonnet-5, claude-haiku-4-5. Use");
    expect(error).not.toContain("more");
    expect(error).not.toContain("of agent");
  });
});
