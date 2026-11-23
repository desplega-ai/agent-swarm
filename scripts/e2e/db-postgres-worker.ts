// Worker half of the synchronous Postgres bridge in db.ts. It owns a Bun.SQL pool,
// runs each query in a READ ONLY transaction (the assertion handle never writes), and
// writes the JSON result into the shared buffer before it wakes the main thread.
declare const self: Worker;

let sql: InstanceType<typeof Bun.SQL> | undefined;
let control: Int32Array;
let data: Uint8Array;
const encoder = new TextEncoder();

// Row values in the SQLite shape scenarios assert on: integers as numbers, flags as 0/1,
// JSON as text, timestamps as ISO text. Columns whose SQLite text has another format get
// their codec from the storage packages once they exist (ledger M3).
function toSqliteShape(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function reply(payload: unknown): void {
  let bytes = encoder.encode(JSON.stringify(payload));
  if (bytes.length > data.length) {
    bytes = encoder.encode(
      JSON.stringify({ ok: false, error: `result over ${data.length} bytes` }),
    );
  }
  data.set(bytes);
  Atomics.store(control, 1, bytes.length);
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
}

self.onmessage = async (event: MessageEvent) => {
  const message = event.data as
    | { type: "init"; url: string; controlBuffer: SharedArrayBuffer; dataBuffer: SharedArrayBuffer }
    | { type: "query"; text: string; params: unknown[] };
  if (message.type === "init") {
    control = new Int32Array(message.controlBuffer);
    data = new Uint8Array(message.dataBuffer);
    sql = new Bun.SQL({ url: message.url, max: 2, bigint: true, connection: { TimeZone: "UTC" } });
    return;
  }
  try {
    const rows = (await sql!.begin("READ ONLY", (tx) =>
      tx.unsafe(message.text, message.params),
    )) as Record<string, unknown>[];
    reply({
      ok: true,
      rows: rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toSqliteShape(v)])),
      ),
    });
  } catch (error) {
    reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
