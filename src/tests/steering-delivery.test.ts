import { afterEach, describe, expect, test } from "bun:test";
import { configureDbResolver, resetDbResolver } from "../prompts/resolver";
import { renderSteeringDelivery } from "../prompts/steering-delivery";

afterEach(resetDbResolver);

describe("steering delivery sender", () => {
  test.each([
    "Taras (user)",
    "Lead (agent)",
    "system",
    "deleted-user (user)",
  ])("renders %s and preserves the acknowledgement marker", async (sender) => {
    const id = crypto.randomUUID();
    expect(await renderSteeringDelivery(id, "change course", sender)).toContain(
      `[steering ${id}] From ${sender}: change course`,
    );
  });

  test("sender is a template variable and whitespace is flattened", async () => {
    configureDbResolver(async () => ({
      template: { id: "custom", scope: "global", body: "{{sender}}: {{body}}" },
    }));
    expect(await renderSteeringDelivery("id", "body", "Taras\n(user)")).toBe("Taras (user): body");
  });

  test("falls back to the bare body on skipped, blank, and failing templates", async () => {
    for (const resolver of [
      async () => ({ skip: true as const }),
      async () => ({ template: { id: "blank", scope: "global", body: " " } }),
      async () => {
        throw new Error("unavailable");
      },
    ]) {
      configureDbResolver(resolver);
      expect(await renderSteeringDelivery("id", "body", "Taras (user)")).toBe("body");
    }
  });
});
