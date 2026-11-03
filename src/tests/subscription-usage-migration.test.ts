import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("subscription usage migration merges historical keys and preserves routes and spend", async () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE session_costs (model TEXT, totalCostUsd REAL, modelBreakdown TEXT)");
    db.run("CREATE TABLE agent_tasks (model TEXT)");
    db.run("INSERT INTO agent_tasks VALUES ('openai-codex/gpt-5.6-luna')");
    const breakdown = [
      { model: "openai-codex/gpt-5.6-luna", inputTokens: 123, totalCostUsd: 2 },
      { model: "openrouter/openai/gpt-5.6-luna", inputTokens: 456, totalCostUsd: 3 },
    ];
    db.run("INSERT INTO session_costs VALUES (?, 5, ?)", [
      " OpenAI-Codex/GPT-5.6-luna ",
      JSON.stringify(breakdown),
    ]);
    db.run("INSERT INTO session_costs VALUES ('gpt-5.6-luna', 7, NULL)");
    db.run("INSERT INTO session_costs VALUES ('openrouter/openai/gpt-5.6-luna', 11, NULL)");
    db.run("INSERT INTO session_costs VALUES ('openai-codex/', 0, NULL)");
    db.run("INSERT INTO session_costs VALUES ('openai-codex/vendor/model', 0, NULL)");
    const sql = await Bun.file(
      new URL("../be/migrations/271_subscription_usage_model.sql", import.meta.url),
    ).text();
    db.exec(sql);
    expect(
      db
        .query(
          "SELECT model, SUM(totalCostUsd) AS cost FROM session_costs GROUP BY model ORDER BY model",
        )
        .all(),
    ).toEqual([
      { model: "gpt-5.6-luna", cost: 12 },
      { model: "openai-codex/", cost: 0 },
      { model: "openai-codex/vendor/model", cost: 0 },
      { model: "openrouter/openai/gpt-5.6-luna", cost: 11 },
    ]);
    expect(db.query("SELECT model FROM agent_tasks").get()).toEqual({
      model: "openai-codex/gpt-5.6-luna",
    });
    const row = db
      .query<{ modelBreakdown: string }, []>(
        "SELECT modelBreakdown FROM session_costs WHERE modelBreakdown IS NOT NULL",
      )
      .get();
    expect(JSON.parse(row!.modelBreakdown)).toEqual([
      { ...breakdown[0], model: "gpt-5.6-luna" },
      breakdown[1],
    ]);
    // Applying it again leaves both identities and monetary totals intact.
    const before = db.query("SELECT * FROM session_costs").all();
    db.exec(sql);
    expect(db.query("SELECT * FROM session_costs").all()).toEqual(before);
  } finally {
    db.close();
  }
});
