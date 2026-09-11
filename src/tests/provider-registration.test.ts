import { describe, expect, test } from "bun:test";
import { type ProviderName, ProviderNameSchema } from "../types";

const registrationSources = {
  credentials: await Bun.file(
    new URL("../commands/provider-credentials.ts", import.meta.url),
  ).text(),
  pricing: await Bun.file(new URL("../be/seed-pricing.ts", import.meta.url)).text(),
  entrypoint: await Bun.file(new URL("../../docker-entrypoint.sh", import.meta.url)).text(),
};

// Claude follows the entrypoint's default branch. ACP targets own their
// credentials and pricing, and do not need the built-in shell bootstrap.
const REGISTRATION_EXEMPTIONS: Partial<
  Record<ProviderName, readonly (keyof typeof registrationSources)[]>
> = {
  claude: ["entrypoint"],
  acp: ["pricing", "entrypoint"],
};

function hasRegistration(
  touchpoint: keyof typeof registrationSources,
  source: string,
  provider: ProviderName,
): boolean {
  switch (touchpoint) {
    case "credentials":
      return source.includes(`case "${provider}":`);
    case "entrypoint":
      return source.includes(`HARNESS_PROVIDER" = "${provider}"`);
    case "pricing":
      return source.includes(`"${provider}"`);
  }
}

describe("provider registration synchronization", () => {
  for (const provider of ProviderNameSchema.options) {
    for (const [touchpoint, source] of Object.entries(registrationSources)) {
      test(`${provider} is registered for ${touchpoint} or explicitly exempt`, () => {
        const exemptions = REGISTRATION_EXEMPTIONS[provider] ?? [];
        expect(
          hasRegistration(touchpoint as keyof typeof registrationSources, source, provider) ||
            exemptions.includes(touchpoint as keyof typeof registrationSources),
        ).toBeTrue();
      });
    }
  }
});
