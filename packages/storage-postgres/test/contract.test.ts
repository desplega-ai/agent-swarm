import { afterAll, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "@desplega/storage";
import { runStorageContract } from "../../storage/test/contract";
import {
  type ColumnClassification,
  createPostgresClient,
  createPostgresStorage,
  loadTimestampFormats,
  type PostgresClient,
  runPostgresMigrations,
} from "../src";
import { createScratchDatabase, postgresTestUrl, type ScratchDatabase } from "./scratch";

// The repository contract suite on Postgres (check 18). One template database
// holds the baseline; each test gets a fresh copy of it.

const CHAIN_DIR = join(import.meta.dir, "..", "..", "..", "src", "be", "migrations", "postgres");
const CLASSIFICATION = JSON.parse(
  readFileSync(join(CHAIN_DIR, "column-types.json"), "utf8"),
) as ColumnClassification;
const quiet = { log: () => {}, warn: () => {} };

let template: ScratchDatabase;
const open = new Map<Storage, { client: PostgresClient; name: string }>();

beforeAll(async () => {
  template = await createScratchDatabase("ctpl");
  const client = createPostgresClient(template.url, { max: 1 });
  try {
    await runPostgresMigrations(client, { migrationsDir: CHAIN_DIR, ...quiet });
  } finally {
    await client.close();
  }
});

afterAll(async () => {
  await template?.drop();
});

let counter = 0;

runStorageContract({
  name: "postgres",
  async fresh() {
    const name = `${template.name}_t${++counter}`;
    const admin = new Bun.SQL(postgresTestUrl());
    try {
      await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${template.name}`);
    } finally {
      await admin.close();
    }
    const url = new URL(template.url);
    url.pathname = `/${name}`;
    const probe = createPostgresClient(url.toString(), { max: 1 });
    const timestampFormats = await loadTimestampFormats(probe, CLASSIFICATION);
    await probe.close();
    const client = createPostgresClient(url.toString(), { max: 4, timestampFormats });
    const storage = createPostgresStorage(client, { vectorSearch: true, dbQuery: false });
    open.set(storage, { client, name });
    return storage;
  },
  async release(storage) {
    const entry = open.get(storage);
    if (!entry) return;
    open.delete(storage);
    await entry.client.close();
    const admin = new Bun.SQL(postgresTestUrl());
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${entry.name} WITH (FORCE)`);
    } finally {
      await admin.close();
    }
  },
  async prepareMemorySearch() {
    // Migration 369 holds the full-text index and memory_vec (no fixed dimension).
  },
});
