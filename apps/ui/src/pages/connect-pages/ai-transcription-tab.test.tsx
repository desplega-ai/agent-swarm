import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  button,
  calls,
  click,
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

const { TranscriptionPanel, TranscriptionTab } = await import("./ai-transcription-tab");

function serve(rows: ReturnType<typeof configRow>[], present: string[]) {
  routes["GET /api/config"] = () => json({ configs: rows });
  routes["GET /api/config/env-presence"] = presenceRoute(present);
  routes["PUT /api/config"] = (_url, init) => json(JSON.parse(String(init?.body)));
  routes["DELETE /api/config/id-TRANSCRIPTION_PROVIDER"] = () => json({ success: true });
}

describe("Transcription tab", () => {
  test("shows the auto-detected provider, its key, model and endpoint", async () => {
    serve([], ["GROQ_API_KEY"]);
    const view = await mount(<TranscriptionTab />);
    await settle();

    const body = text();
    expect(body).toContain("Groq");
    expect(body).toContain("auto-detected");
    expect(body).toContain("GROQ_API_KEY");
    expect(body).toContain("whisper-large-v3-turbo");
    expect(body).toContain("https://api.groq.com/openai/v1");
    expect(body).toContain("Auto-detect order");
    await view.cleanup();
  });

  test("a pinned provider without its key is off and says why", async () => {
    serve([configRow("TRANSCRIPTION_PROVIDER", "openai")], ["ELEVENLABS_API_KEY"]);
    const view = await mount(<TranscriptionTab />);
    await settle();

    expect(text()).toContain(
      "TRANSCRIPTION_PROVIDER pins OpenAI, and the swarm has no OPENAI_API_KEY.",
    );
    await view.cleanup();
  });

  test("Change provider pins a provider through the config API", async () => {
    serve([], ["ELEVENLABS_API_KEY"]);
    let open = true;
    const view = await mount(
      <TranscriptionPanel
        open
        onOpenChange={(next) => {
          open = next;
        }}
      />,
    );
    await settle();

    expect(text()).toContain("Change transcription provider");
    const groq = Array.from(document.body.querySelectorAll('[role="radio"]')).find(
      (el) => el.textContent === "Groq",
    ) as HTMLElement;
    await click(groq);
    expect(text()).toContain("The swarm has no GROQ_API_KEY.");
    await click(button("Save"));
    await settle();

    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
      expect.objectContaining({ key: "TRANSCRIPTION_PROVIDER", value: "groq", isSecret: false }),
    ]);
    expect(open).toBe(false);
    await view.cleanup();
  });

  test("Auto-detect deletes the pin; Cancel writes nothing", async () => {
    serve([configRow("TRANSCRIPTION_PROVIDER", "groq")], ["ELEVENLABS_API_KEY"]);
    const view = await mount(<TranscriptionPanel open onOpenChange={() => {}} />);
    await settle();

    await click(button("Cancel"));
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);

    const auto = Array.from(document.body.querySelectorAll('[role="radio"]')).find(
      (el) => el.textContent === "Auto-detect",
    ) as HTMLElement;
    await click(auto);
    await click(button("Save"));
    await settle();
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /api/config/id-TRANSCRIPTION_PROVIDER",
    ]);
    await view.cleanup();
  });
});
