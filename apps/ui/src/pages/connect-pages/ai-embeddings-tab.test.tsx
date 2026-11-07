import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  calls,
  configRow,
  installAiTabDom,
  json,
  mount,
  presenceRoute,
  routes,
  settle,
  text,
} from "./ai-tabs-test-dom";

await installAiTabDom({ mock, beforeEach, afterEach, afterAll });

const { EmbeddingsPanel, EmbeddingsTab } = await import("./ai-embeddings-tab");

function onboarding(embeddings: Record<string, unknown>) {
  return { state: { steps: {} }, signals: { embeddings } };
}

describe("Embeddings tab", () => {
  test("shows the provider, model, size and key memory uses now", async () => {
    routes["GET /api/onboarding"] = () =>
      json(
        onboarding({
          configured: true,
          dimensions: 512,
          model: "openai/text-embedding-3-small",
          local: false,
          provider: "openrouter",
          localDefault: null,
        }),
      );
    routes["GET /api/config"] = () =>
      json({ configs: [configRow("EMBEDDING_API_BASE_URL", "https://openrouter.ai/api/v1")] });
    routes["GET /api/config/env-presence"] = presenceRoute(["EMBEDDING_API_KEY"]);
    const view = await mount(<EmbeddingsTab />);
    await settle();

    const body = text();
    expect(body).toContain("OpenRouter");
    expect(body).toContain("On");
    expect(body).toContain("openai/text-embedding-3-small");
    expect(body).toContain("512");
    expect(body).toContain("EMBEDDING_API_KEY");
    expect(body).toContain("https://openrouter.ai/api/v1");
    expect(body).toContain("Before you change it");
    await view.cleanup();
  });

  test("with no embeddings it says recall is keyword search only", async () => {
    routes["GET /api/onboarding"] = () =>
      json(onboarding({ configured: false, dimensions: 512, model: null, provider: null }));
    routes["GET /api/config"] = () => json({ configs: [] });
    routes["GET /api/config/env-presence"] = presenceRoute([]);
    const view = await mount(<EmbeddingsTab />);
    await settle();

    expect(text()).toContain("Keyword search only");
    expect(text()).toContain("Off");
    await view.cleanup();
  });

  test("Change provider lists the presets and closing it writes nothing", async () => {
    routes["GET /api/onboarding"] = () =>
      json(onboarding({ configured: false, dimensions: 512, model: null, provider: null }));
    routes["GET /api/config"] = () => json({ configs: [] });
    routes["GET /api/config/env-presence"] = presenceRoute([]);
    let open = true;
    const view = await mount(
      <EmbeddingsPanel
        open
        onOpenChange={(next) => {
          open = next;
        }}
      />,
    );
    await settle();

    const body = text();
    expect(body).toContain("Change embeddings provider");
    for (const preset of [
      "OpenAI",
      "OpenRouter",
      "Vercel AI Gateway",
      "Azure / Microsoft Foundry",
      "Custom",
    ]) {
      expect(body).toContain(preset);
    }
    const close = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Close",
    );
    close?.click();
    await settle(2);
    expect(open).toBe(false);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    await view.cleanup();
  });
});
