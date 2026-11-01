import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { MODEL_TIERS } from "../types";

const taskLifecyclePath = resolve(
  import.meta.dir,
  "../../docs-site/content/docs/(documentation)/concepts/task-lifecycle.mdx",
);

describe("task lifecycle documentation", () => {
  test("documents portable model tiers and harness-specific defaults", async () => {
    const content = await Bun.file(taskLifecyclePath).text();
    const taskProperties = content.match(/## Task Properties[\s\S]*?(?=\n## )/)?.[0] ?? "";

    expect(taskProperties).toContain(
      "| `model` | Concrete provider-specific model override. Wins over `modelTier` when both are present. |",
    );
    expect(taskProperties).toContain(
      `| \`modelTier\` | Portable model intent: ${MODEL_TIERS.map((tier) => `\`${tier}\``).join(", ")}.`,
    );
    expect(taskProperties).toContain(
      "Without either override, the assignee uses its harness-specific default.",
    );
    expect(taskProperties).toContain(
      "[model-tier reference](https://github.com/desplega-ai/agent-swarm/blob/main/runbooks/model-tiers.md)",
    );
    expect(taskProperties).not.toContain("fallback is `opus`");
    expect(taskProperties).not.toContain("config > `opus`");
  });
});
