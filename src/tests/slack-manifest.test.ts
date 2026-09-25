import { afterEach, describe, expect, test } from "bun:test";
import { buildSlackManifest } from "../slack/manifest";

const originalName = process.env.SWARM_ORG_NAME;

afterEach(() => {
  if (originalName === undefined) delete process.env.SWARM_ORG_NAME;
  else process.env.SWARM_ORG_NAME = originalName;
});

describe("buildSlackManifest", () => {
  test("injects a trimmed name and removes redirect URLs", () => {
    const manifest = buildSlackManifest(`  ${"A".repeat(40)}  `);
    expect(manifest.display_information.name).toBe("A".repeat(35));
    expect(manifest.features.bot_user.display_name).toBe("A".repeat(35));
    expect("redirect_urls" in manifest.oauth_config).toBe(false);
  });

  test("falls back to the configured swarm name", () => {
    process.env.SWARM_ORG_NAME = "Configured Swarm";
    expect(buildSlackManifest(" ").display_information.name).toBe("Configured Swarm");
  });
});
