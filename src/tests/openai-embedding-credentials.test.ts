import { expect, test } from "bun:test";
import { OpenAIEmbeddingProvider } from "../be/memory/providers/openai-embedding";

for (const source of ["config", "EMBEDDING_API_KEY", "OPENAI_API_KEY"] as const) {
  test(`embedding selects one key from ${source}`, async () => {
    const originalFetch = globalThis.fetch;
    const saved = {
      EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    delete process.env.EMBEDDING_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const pool = "example-first, example-second";
    if (source !== "config") process.env[source] = pool;
    let authorization: string | null = null;
    globalThis.fetch = (async (input, init) => {
      authorization = new Request(input, init).headers.get("authorization");
      return Response.json({ data: [{ embedding: [0.5] }] });
    }) as typeof fetch;
    try {
      const provider = new OpenAIEmbeddingProvider({
        dimensions: 1,
        ...(source === "config" ? { apiKey: pool } : {}),
      });
      expect(await provider.embed("test input")).toEqual(new Float32Array([0.5]));
      expect(["Bearer example-first", "Bearer example-second"]).toContain(authorization);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}
