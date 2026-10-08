import { afterEach, describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { createJudgeOpenRouter } from "./openrouter.ts";

async function sentHeaders(): Promise<Headers> {
  let headers = new Headers();
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    return new Response("bad request", { status: 400 });
  }) as typeof fetch;
  const openrouter = createJudgeOpenRouter("example-or-key", fetchImpl);
  await generateText({ model: openrouter("google/gemini-3-flash-preview"), prompt: "hi" }).catch(
    () => {},
  );
  return headers;
}

describe("createJudgeOpenRouter", () => {
  afterEach(() => {
    delete process.env.OPENROUTER_APP_ATTRIBUTION;
  });

  test("attributes judge calls to Agent Swarm", async () => {
    const headers = await sentHeaders();
    expect(headers.get("http-referer")).toBe("https://agent-swarm.dev");
    expect(headers.get("x-openrouter-title")).toBe("Agent Swarm");
    expect(headers.get("x-openrouter-categories")).toBe("personal-agent,cloud-agent");
  });

  test("OPENROUTER_APP_ATTRIBUTION=false sends no attribution", async () => {
    process.env.OPENROUTER_APP_ATTRIBUTION = "false";
    const headers = await sentHeaders();
    expect(headers.get("authorization")).toBe("Bearer example-or-key");
    expect(headers.has("http-referer")).toBe(false);
    expect(headers.has("x-openrouter-categories")).toBe(false);
  });
});
