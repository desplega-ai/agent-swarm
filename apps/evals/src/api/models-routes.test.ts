import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetCatalogForTests } from "../cost/catalog.ts";
import { resetDbForTests } from "../db/client.ts";
import { setDbConfigs } from "../registry.ts";
import { startServer } from "./server.ts";

const ENV_KEYS = ["EVALS_API_KEY", "EVALS_DB_PATH", "EVALS_DB_SYNC_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

beforeEach(() => {
  resetDbForTests();
  resetCatalogForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
});

afterEach(() => {
  resetDbForTests();
  resetCatalogForTests();
  setDbConfigs(null);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

interface ModelRow {
  id: string;
  name: string;
  inputPerM: number | null;
}

interface ModelsBody {
  defaultJudgeModel: string;
  models: ModelRow[];
  harnessModels: ModelRow[];
  aliases: Record<string, string>;
  catalog: { source: string; fetchedAt: string | null };
}

describe("GET /api/models", () => {
  test("judge list stays openrouter-only; harnessModels adds claude + codex ids", async () => {
    const server = await startServer(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/models`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ModelsBody;

      expect(body.models.some((m) => m.id === body.defaultJudgeModel)).toBe(true);
      expect(body.models.some((m) => m.id.startsWith("claude-"))).toBe(false);

      const sonnet = body.harnessModels.find((m) => m.id === "claude-sonnet-5-5");
      expect(sonnet?.name).toBeTruthy();
      expect(sonnet?.inputPerM).not.toBeNull();
      expect(body.harnessModels.some((m) => m.id === "gpt-5.6-sol")).toBe(true);
      const judgeIds = new Set(body.models.map((m) => m.id));
      expect(body.harnessModels.some((m) => judgeIds.has(m.id))).toBe(false);

      expect(body.aliases.opus).toStartWith("claude-opus");
      // Offline (NODE_ENV=test): no refresh loop, so the committed snapshot serves.
      expect(body.catalog).toEqual({ source: "snapshot", fetchedAt: null });
    } finally {
      server.stop(true);
    }
  });
});
