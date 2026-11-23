/**
 * A throwaway database on the Postgres server named by `STORAGE_TEST_POSTGRES_URL`
 * (a URL to a maintenance database such as `postgres`). Created with the C
 * collation and character classes, like every swarm database.
 */
export type ScratchDatabase = { url: string; name: string; drop(): Promise<void> };

export function postgresTestUrl(): string {
  const url = process.env.STORAGE_TEST_POSTGRES_URL;
  if (!url) {
    throw new Error(
      "STORAGE_TEST_POSTGRES_URL is not set (for example postgres://postgres@127.0.0.1:5432/postgres)",
    );
  }
  return url;
}

export async function createScratchDatabase(label: string): Promise<ScratchDatabase> {
  const adminUrl = postgresTestUrl();
  const name = `st_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Bun.SQL(adminUrl);
  try {
    await admin.unsafe(
      `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
  } finally {
    await admin.close();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    name,
    async drop() {
      const dropper = new Bun.SQL(adminUrl);
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.close();
      }
    },
  };
}
