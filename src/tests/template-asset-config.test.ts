import { expect, test } from "bun:test";
import { ASSET_CATEGORIES } from "../../templates/schema";

const templatesDir = new URL("../../templates/", import.meta.url).pathname;

for (const category of ASSET_CATEGORIES) {
  for (const configPath of new Bun.Glob(`${category}/*/config.json`).scanSync(templatesDir)) {
    test(`${configPath} declares the arrays consumed by the template gallery`, async () => {
      const config = await Bun.file(`${templatesDir}${configPath}`).json();
      expect(config.placeholders).toBeArray();
      expect(config.placeholders.every((value: unknown) => typeof value === "string")).toBe(true);
      if (category === "workflows") {
        expect(config.requires).toBeArray();
        expect(config.requires.every((value: unknown) => typeof value === "string")).toBe(true);
      }
    });
  }
}
