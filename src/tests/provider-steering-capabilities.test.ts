import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createProviderAdapter } from "../providers";
import { PROVIDER_STEER_CAPABILITIES, ProviderNameSchema } from "../types";

// The claude-managed adapter ctor requires these env vars; stub them so the
// trait comparison runs in CI (same pattern as claude-managed-adapter.test.ts).
const MANAGED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "MANAGED_AGENT_ID",
  "MANAGED_ENVIRONMENT_ID",
] as const;
const savedManagedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of MANAGED_ENV_KEYS) {
    savedManagedEnv[key] = process.env[key];
    if (!process.env[key]) process.env[key] = `test-${key.toLowerCase()}`;
  }
});

afterAll(() => {
  for (const key of MANAGED_ENV_KEYS) {
    if (savedManagedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedManagedEnv[key];
  }
});

describe("provider steering capability synchronization", () => {
  for (const provider of ProviderNameSchema.options) {
    test(`${provider} adapter traits match PROVIDER_STEER_CAPABILITIES`, async () => {
      const adapter = await createProviderAdapter(provider);
      const actual = adapter.traits.steerModes ?? [];
      const expected = PROVIDER_STEER_CAPABILITIES[provider];

      try {
        expect(actual).toEqual(expected);
      } catch (error) {
        throw new Error(
          `Steering capability mismatch for provider "${provider}": adapter=${JSON.stringify(actual)}, map=${JSON.stringify(expected)}. ${String(error)}`,
        );
      }
    });
  }
});
