import { describe, expect, test } from "bun:test";
import { createProviderAdapter } from "../providers";
import { PROVIDER_STEER_CAPABILITIES, ProviderNameSchema } from "../types";

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
