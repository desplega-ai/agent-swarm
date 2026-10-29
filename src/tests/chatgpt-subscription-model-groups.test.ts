/**
 * The pi model picker's ChatGPT subscription group: present only while a
 * `codex_oauth` pool slot exists, listing the codex harness models under
 * `openai-codex/<id>`.
 */

import { describe, expect, test } from "bun:test";
import type { SwarmConfig } from "../../apps/ui/src/api/types";
import {
  CHATGPT_SUBSCRIPTION_LABEL,
  effortLevelsFor,
  findKnownModel,
  modelGroupsForHarness,
} from "../../apps/ui/src/lib/agent-runtime-models";

function configRow(key: string, value: string): SwarmConfig {
  return { key, value } as SwarmConfig;
}

const withSlot = [configRow("codex_oauth_0", "********")];

describe("ChatGPT subscription group", () => {
  test("hidden on pi without a codex_oauth slot", () => {
    const groups = modelGroupsForHarness("pi", [configRow("codex_oauth_0", "")], undefined);
    expect(groups.find((g) => g.provider === CHATGPT_SUBSCRIPTION_LABEL)).toBeUndefined();
  });

  test("shown and enabled on pi with a slot, holding the codex list as openai-codex ids", () => {
    const group = modelGroupsForHarness("pi", withSlot, undefined).find(
      (g) => g.provider === CHATGPT_SUBSCRIPTION_LABEL,
    );
    const codexIds = modelGroupsForHarness("codex", undefined, undefined)[0].models.map(
      (m) => `openai-codex/${m.id}`,
    );
    expect(group?.enabled).toBe(true);
    expect(group?.models.map((m) => m.id)).toEqual(codexIds);
    expect(group?.models.every((m) => m.cost === undefined)).toBe(true);
  });

  test("not offered on opencode or codex", () => {
    for (const harness of ["opencode", "codex"] as const) {
      const groups = modelGroupsForHarness(harness, withSlot, undefined);
      expect(groups.find((g) => g.provider === CHATGPT_SUBSCRIPTION_LABEL)).toBeUndefined();
    }
  });

  test("a stored subscription id displays as its catalog model and keeps its effort levels", () => {
    const known = findKnownModel("openai-codex/gpt-5.6-sol");
    expect(known?.provider).toBe(CHATGPT_SUBSCRIPTION_LABEL);
    expect(known?.label).not.toBe("openai-codex/gpt-5.6-sol");
    expect(effortLevelsFor("pi", "openai-codex/gpt-5.6-sol")).toEqual(
      effortLevelsFor("pi", "openai/gpt-5.6-sol"),
    );
    expect(effortLevelsFor("pi", "openai-codex/gpt-5.6-sol").length).toBeGreaterThan(0);
  });

  test("a mixed-case prefix keeps its effort levels", () => {
    expect(effortLevelsFor("pi", "OpenAI-Codex/gpt-5.6-sol")).toEqual(
      effortLevelsFor("pi", "openai/gpt-5.6-sol"),
    );
  });
});
