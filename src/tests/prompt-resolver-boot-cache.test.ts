/**
 * Coverage for the boot-scoped HTTP render cache in `src/prompts/resolver.ts`.
 *
 * A worker resolves the same system-prompt templates several times while it
 * boots. The cache exists to make those repeats free, but it must stay inert
 * outside the boot window so a task dispatch always sees a freshly edited
 * template.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  beginBootRenderCache,
  configureHttpResolver,
  endBootRenderCache,
  resetHttpResolver,
  resolveTemplateAsync,
} from "../prompts/resolver";

let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = "";
let renderCalls = 0;
let failNextRender = false;

describe("boot render cache", () => {
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        renderCalls++;
        if (failNextRender) {
          failNextRender = false;
          return new Response("boom", { status: 500 });
        }
        const body = (await req.json()) as {
          eventType: string;
          variables: Record<string, unknown>;
        };
        return Response.json({
          text: `${body.eventType}:${JSON.stringify(body.variables)}`,
          skipped: false,
          unresolved: [],
        });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
    configureHttpResolver(baseUrl, "test-key");
  });

  afterAll(() => {
    resetHttpResolver();
    server?.stop(true);
  });

  test("identical renders during boot share one round trip", async () => {
    renderCalls = 0;
    beginBootRenderCache();
    try {
      const first = await resolveTemplateAsync("system.agent", { agent: "a" });
      const second = await resolveTemplateAsync("system.agent", { agent: "a" });
      expect(second).toEqual(first);
      expect(renderCalls).toBe(1);

      // Different variables are a different render.
      await resolveTemplateAsync("system.agent", { agent: "b" });
      expect(renderCalls).toBe(2);
    } finally {
      endBootRenderCache();
    }
  });

  test("outside the boot window every render goes to the API", async () => {
    renderCalls = 0;
    await resolveTemplateAsync("system.agent", { agent: "a" });
    await resolveTemplateAsync("system.agent", { agent: "a" });
    expect(renderCalls).toBe(2);
  });

  test("a failed render is not cached, so the next call retries", async () => {
    renderCalls = 0;
    failNextRender = true;
    beginBootRenderCache();
    try {
      await resolveTemplateAsync("system.agent", { agent: "c" });
      await resolveTemplateAsync("system.agent", { agent: "c" });
      expect(renderCalls).toBe(2);
    } finally {
      endBootRenderCache();
    }
  });
});
