import { asRecord, createApiClient, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { startSut, stopSut } from "../sut";

export const pingSerializationRetry: Scenario = {
  name: "ping-serialization-retry",
  order: 9_045,
  async run() {
    const sut = await startSut(
      false,
      { SLACK_DISABLE: "true" },
      { E2E_POSTGRES_SEED_SQL: `${import.meta.dir}/../fixtures/ping-serialization-retry.sql` },
      undefined,
      "postgres",
    );
    try {
      const api = createApiClient(sut.baseUrl, sut.apiKey);
      const agentId = crypto.randomUUID();
      const registered = await api("POST", "/api/agents", {
        agentId,
        body: { name: "ping-retry", role: "worker" },
      });
      expectStatus(registered, [201], "register worker");

      const rename = async (name: string) => {
        const response = await api("PUT", `/api/agents/${agentId}/name`, { body: { name } });
        expectStatus(response, [200], `rename worker to ${name}`);
      };
      for (const table of ["agents", "agent_log"]) {
        await rename(`ping-conflict-${table}`);
        const response = await api("POST", "/ping", { agentId });
        expectStatus(response, [503], `ping when ${table} exhausts retries`);
        expect(response.headers.get("Retry-After") === "1", "ping advertises a one-second retry");
        expect(
          asRecord(response.json).error === "Liveness update temporarily unavailable",
          "ping returns a public error",
        );
      }
      await rename("ping-retry");
      expectStatus(await api("POST", "/ping", { agentId }), [204], "ping after contention clears");
    } finally {
      await stopSut(sut, false);
    }
  },
};
