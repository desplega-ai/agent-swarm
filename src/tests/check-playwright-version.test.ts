import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  checkPlaywrightPins,
  DOCKERFILE,
  UI_E2E_PACKAGE_JSON,
} from "../../scripts/check-playwright-version";

const repoRoot = join(import.meta.dir, "..", "..");
const dockerfile = (version: string) =>
  `RUN cat > package.json <<'EOF'\n{\n  "dependencies": {\n    "playwright": "${version}"\n  }\n}\nEOF\n`;
const uiE2e = (version: string) => ({ devDependencies: { "@playwright/test": version } });

describe("Playwright pin check", () => {
  test("the committed Dockerfile.worker and ui-e2e pins match", async () => {
    const problems = checkPlaywrightPins(
      await Bun.file(join(repoRoot, DOCKERFILE)).text(),
      await Bun.file(join(repoRoot, UI_E2E_PACKAGE_JSON)).json(),
    );
    expect(problems).toEqual([]);
  });

  test("a drifted Dockerfile pin fails", () => {
    expect(checkPlaywrightPins(dockerfile("1.58.0"), uiE2e("1.63.0"))).toEqual([
      `${DOCKERFILE}: global playwright is 1.58.0, ${UI_E2E_PACKAGE_JSON} @playwright/test is 1.63.0`,
    ]);
  });

  test("a missing pin on either side fails", () => {
    expect(checkPlaywrightPins("FROM ubuntu\n", uiE2e("1.63.0"))).toHaveLength(1);
    expect(checkPlaywrightPins(dockerfile("1.63.0"), { devDependencies: {} })).toHaveLength(1);
  });
});
