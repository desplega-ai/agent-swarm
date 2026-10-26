import { describe, expect, test } from "bun:test";
import type { SwarmConfig } from "../api/types";
import {
  buildInitialState,
  computeDirtyEntries,
  reconcileWithStored,
  SECRET_MASK_SENTINEL,
} from "./integration-form-state";
import { getIntegrationFields, INTEGRATIONS } from "./integrations-catalog";

const memory = INTEGRATIONS.find((integration) => integration.id === "memory")!;
const fields = getIntegrationFields(memory);

function row(key: string, value: string, isSecret = false): SwarmConfig {
  return {
    id: key,
    scope: "global",
    scopeId: null,
    key,
    value,
    isSecret,
    envPath: null,
    description: null,
    createdAt: "2026-10-02T00:00:00.000Z",
    lastUpdatedAt: "2026-10-02T00:00:00.000Z",
    encrypted: false,
    exportToEnv: true,
  };
}

const AZURE_URL = "https://contoso.services.ai.azure.com/openai/v1";

// What the probe stores after a successful Azure / Foundry test.
const afterProbe = [
  row("EMBEDDING_API_KEY", SECRET_MASK_SENTINEL, true),
  row("EMBEDDING_API_BASE_URL", AZURE_URL),
  row("EMBEDDING_MODEL", "my-embedding-deployment"),
];

describe("integration form state after another editor saves the same keys", () => {
  test("a successful probe refreshes untouched fields and Save does not revert it", () => {
    const before = [
      row("EMBEDDING_API_KEY", SECRET_MASK_SENTINEL, true),
      row("EMBEDDING_API_BASE_URL", "https://api.openai.com/v1"),
      row("EMBEDDING_MODEL", "text-embedding-3-small"),
    ];
    const oldBaseline = buildInitialState(memory, before);
    const nextBaseline = buildInitialState(memory, afterProbe);

    // Without reconciling, the stale form would send the old URL and model back.
    expect(computeDirtyEntries(fields, oldBaseline, afterProbe).map((e) => e.value)).toEqual([
      "https://api.openai.com/v1",
      "text-embedding-3-small",
    ]);

    const state = reconcileWithStored(oldBaseline, oldBaseline, nextBaseline);
    expect(state.EMBEDDING_API_BASE_URL?.value).toBe(AZURE_URL);
    expect(state.EMBEDDING_MODEL?.value).toBe("my-embedding-deployment");
    expect(computeDirtyEntries(fields, state, afterProbe)).toEqual([]);
  });

  test("on a fresh install, the empty form picks up the probe's values", () => {
    const oldBaseline = buildInitialState(memory, []);
    const state = reconcileWithStored(
      oldBaseline,
      oldBaseline,
      buildInitialState(memory, afterProbe),
    );
    expect(state.EMBEDDING_API_KEY?.value).toBe(SECRET_MASK_SENTINEL);
    expect(state.EMBEDDING_API_BASE_URL?.value).toBe(AZURE_URL);
    expect(computeDirtyEntries(fields, state, afterProbe)).toEqual([]);
  });

  test("a deliberate unsaved edit survives the refresh and stays dirty", () => {
    const oldBaseline = buildInitialState(memory, []);
    const edited = {
      ...oldBaseline,
      EMBEDDING_MODEL: { value: "text-embedding-3-large" },
      EMBEDDING_API_KEY: { value: "sk-typed", markedForReplace: true },
    };
    const state = reconcileWithStored(edited, oldBaseline, buildInitialState(memory, afterProbe));
    expect(state.EMBEDDING_API_BASE_URL?.value).toBe(AZURE_URL);
    expect(state.EMBEDDING_MODEL?.value).toBe("text-embedding-3-large");
    expect(state.EMBEDDING_API_KEY).toEqual({ value: "sk-typed", markedForReplace: true });
    expect(computeDirtyEntries(fields, state, afterProbe).map((e) => e.key)).toEqual([
      "EMBEDDING_API_KEY",
      "EMBEDDING_MODEL",
    ]);
  });
});

describe("credential pool fields", () => {
  const anthropic = INTEGRATIONS.find((integration) => integration.id === "anthropic")!;
  const anthropicFields = getIntegrationFields(anthropic);

  test("a typed pool value never reaches the page Save", () => {
    expect(anthropicFields.every((field) => field.credentialPool)).toBe(true);
    const state = {
      CLAUDE_CODE_OAUTH_TOKEN: { value: "sk-ant-oat01-typed", markedForReplace: true },
      ANTHROPIC_API_KEY: { value: "sk-ant-api03-typed" },
    };
    expect(computeDirtyEntries(anthropicFields, state, [])).toEqual([]);
  });

  test("an API without the pool-keys route saves a typed pool with the page", () => {
    const state = { ANTHROPIC_API_KEY: { value: "sk-ant-api03-first,sk-ant-api03-secnd" } };
    expect(computeDirtyEntries(anthropicFields, state, [], { poolLists: false })).toMatchObject([
      { key: "ANTHROPIC_API_KEY", value: "sk-ant-api03-first,sk-ant-api03-secnd", isSecret: true },
    ]);
  });
});
