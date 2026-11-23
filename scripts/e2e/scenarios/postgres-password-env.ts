import { createPostgresRole, dropPostgresRole } from "../db";
import { createApiClient, expectStatus } from "../http";
import type { Scenario } from "../run";
import { startSut, stopSut } from "../sut";

// The Compose overlay (docker-compose.postgres.yml) passes the raw POSTGRES_PASSWORD
// as DATABASE_PASSWORD next to a DATABASE_URL without a password. A password with
// `/`, `@`, `#`, `%` and `:` must still reach Postgres unchanged: the API URL-encodes it.
export const postgresPasswordEnv: Scenario = {
  name: "postgres-password-env",
  order: 9_060,
  async run(ctx) {
    const role = `e2e_pw_${ctx.nonce}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const password = `p/w@1#2%3:4?${ctx.nonce}`;
    await createPostgresRole(role, password);
    let sut: Awaited<ReturnType<typeof startSut>> | undefined;
    try {
      sut = await startSut(
        false,
        { SLACK_DISABLE: "true" },
        {},
        undefined,
        "postgres",
        async (s) => {
          const url = new URL(s.env.DATABASE_URL as string);
          url.username = role;
          url.password = "";
          s.env.DATABASE_URL = url.toString();
          s.env.DATABASE_PASSWORD = password;
        },
      );
      const created = await createApiClient(sut.baseUrl, sut.apiKey)("POST", "/api/tasks", {
        body: { task: `password env ${ctx.nonce}`, followUpConfig: { disabled: true } },
      });
      expectStatus(created, [201], "create a task on Postgres with DATABASE_PASSWORD");
    } finally {
      if (sut) await stopSut(sut, false);
      await dropPostgresRole(role);
    }
  },
};
