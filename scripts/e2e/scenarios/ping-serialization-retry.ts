import { asRecord, createApiClient, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { startSut, stopSut } from "../sut";

export const pingSerializationRetry: Scenario = {
  name: "ping-serialization-retry",
  order: 9_045,
  async run() {
    const sut = await startSut(false, { SLACK_DISABLE: "true" }, {}, undefined, "postgres");
    const db = new Bun.SQL({ url: sut.databaseUrl, max: 1 });
    try {
      const api = createApiClient(sut.baseUrl, sut.apiKey);
      const agentId = crypto.randomUUID();
      const registered = await api("POST", "/api/agents", {
        agentId,
        body: { name: "ping-retry", role: "worker" },
      });
      expectStatus(registered, [201], "register worker");

      // Fail every attempt in this isolated database, including the best-effort
      // log write whose caught error is reported only when the transaction ends.
      await db.unsafe(`CREATE FUNCTION fail_ping() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE serialization_failure USING MESSAGE = 'injected ping conflict'; END $$`);
      for (const [event, table] of [
        ["UPDATE OF status", "agents"],
        ["INSERT", "agent_log"],
      ]) {
        await db.unsafe(
          `CREATE TRIGGER fail_ping BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_ping()`,
        );
        const response = await api("POST", "/ping", { agentId });
        expectStatus(response, [503], `ping when ${table} exhausts retries`);
        expect(response.headers.get("Retry-After") === "1", "ping advertises a one-second retry");
        expect(
          asRecord(response.json).error === "Liveness update temporarily unavailable",
          "ping returns a public error",
        );
        await db.unsafe(`DROP TRIGGER fail_ping ON ${table}`);
      }
      expectStatus(await api("POST", "/ping", { agentId }), [204], "ping after contention clears");
    } finally {
      await db.close();
      await stopSut(sut, false);
    }
  },
};
