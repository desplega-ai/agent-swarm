import type { Socket } from "bun";
import { asRecord, asString, createApiClient, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { restartSut, type Sut, startSut, stopSut } from "../sut";

type Side = Socket<Pair>;
type Pair = {
  client: Side;
  upstream?: Side;
  /** Bytes from the client that wait for the upstream connection. */
  early: Uint8Array[];
  /** Pending bytes per side when a write was short (backpressure). */
  pending: Map<Side, Uint8Array[]>;
  dead: boolean;
};

/**
 * A TCP proxy between the API and PostgreSQL that can make the API's connections
 * dead without closing them: `cut()` stops forwarding on every open connection and
 * closes only the database side, so PostgreSQL ends those sessions (as when the
 * database restarts) while the API's sockets get no FIN or RST (as when the database
 * comes back on another address, or a network drops packets). New connections hang
 * until `heal()`, then forward again. Old connections stay dead.
 */
export async function startBlackholeProxy(upstreamHost: string, upstreamPort: number) {
  const pairs = new Set<Pair>();
  let forwarding = true;

  const write = (pair: Pair, to: Side, data: Uint8Array) => {
    const queue = pair.pending.get(to);
    if (queue && queue.length > 0) {
      queue.push(data);
      return;
    }
    const sent = to.write(data);
    if (sent < data.byteLength) pair.pending.set(to, [data.subarray(sent)]);
  };
  const flush = (pair: Pair, side: Side) => {
    const queue = pair.pending.get(side);
    while (queue && queue.length > 0) {
      const head = queue[0] as Uint8Array;
      const sent = side.write(head);
      if (sent < head.byteLength) {
        queue[0] = head.subarray(sent);
        return;
      }
      queue.shift();
    }
  };
  const kill = (pair: Pair) => {
    // The client socket stays open and silent. The database side closes.
    pair.dead = true;
    pair.early = [];
    pair.pending.clear();
    pair.upstream?.end();
  };

  const connectUpstream = async (pair: Pair) => {
    const upstream = await Bun.connect<Pair>({
      hostname: upstreamHost,
      port: upstreamPort,
      data: pair,
      socket: {
        data(_socket, data) {
          if (!pair.dead) write(pair, pair.client, data);
        },
        drain(socket) {
          if (!pair.dead) flush(pair, socket);
        },
        close() {
          if (!pair.dead) pair.client.end();
        },
        error() {
          if (!pair.dead) pair.client.end();
        },
      },
    });
    if (pair.dead) {
      upstream.end();
      return;
    }
    pair.upstream = upstream;
    for (const chunk of pair.early) write(pair, upstream, chunk);
    pair.early = [];
  };

  const server = Bun.listen<Pair>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        const pair: Pair = { client, early: [], pending: new Map(), dead: !forwarding };
        client.data = pair;
        pairs.add(pair);
        if (!pair.dead) {
          connectUpstream(pair).catch(() => {
            if (!pair.dead) client.end();
          });
        }
      },
      data(client, data) {
        const pair = client.data;
        if (pair.dead) return;
        if (pair.upstream) write(pair, pair.upstream, data);
        else pair.early.push(new Uint8Array(data));
      },
      drain(client) {
        const pair = client.data;
        if (!pair.dead) flush(pair, client);
      },
      close(client) {
        const pair = client.data;
        pairs.delete(pair);
        if (!pair.dead) pair.upstream?.end();
      },
      error() {},
    },
  });

  return {
    port: server.port,
    /** Every open connection goes dead, and new connections hang. */
    cut() {
      forwarding = false;
      for (const pair of pairs) kill(pair);
    },
    /** New connections forward again (the database is back). Dead ones stay dead. */
    heal() {
      forwarding = true;
    },
    stop() {
      for (const pair of pairs) {
        pair.dead = true;
        pair.upstream?.end();
        pair.client.end();
      }
      pairs.clear();
      server.stop(true);
    },
  };
}

/** Bounds of the fix (runbooks/postgres.md, "When the database is unreachable"). */
const FAIL_WITHIN_MS = 30_000;
const RECOVER_WITHIN_MS = 60_000;

/** How a request that needs the database ends, and when ("still open" at `limitMs`). */
async function settleMs(sut: Sut, limitMs: number): Promise<{ ms: number; outcome: string }> {
  const started = performance.now();
  try {
    const response = await fetch(`${sut.baseUrl}/api/tasks?limit=5`, {
      headers: { Authorization: `Bearer ${sut.apiKey}` },
      signal: AbortSignal.timeout(limitMs),
    });
    await response.text();
    return { ms: performance.now() - started, outcome: `HTTP ${response.status}` };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const outcome = name === "TimeoutError" ? "still open" : `connection error (${name})`;
    return { ms: performance.now() - started, outcome };
  }
}

/** Milliseconds until /health stops answering 200, or `limitMs` if it stays green. */
async function healthGreenMs(sut: Sut, limitMs: number): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < limitMs) {
    const ok = await fetch(`${sut.baseUrl}/health`, { signal: AbortSignal.timeout(1_000) })
      .then((response) => response.status === 200)
      .catch(() => false);
    if (!ok) return performance.now() - started;
    await Bun.sleep(250);
  }
  return limitMs;
}

// Kinoko finding on #3562: when PostgreSQL comes back on another address, or the
// network drops packets, the API's connections get no FIN or RST. Before the fix the
// API kept /health green and every database request hung until the kernel gave up on
// the sockets (934 s on Linux defaults). Now the lock watchdog notices within seconds,
// the API exits non-zero, and the supervisor's restart (played here by the scenario)
// reconnects on a fresh pool.
export const postgresDeadConnections: Scenario = {
  name: "postgres-dead-connections",
  order: 9_065,
  async run(ctx) {
    const held: { proxy?: Awaited<ReturnType<typeof startBlackholeProxy>> } = {};
    let sut: Sut | undefined;
    try {
      sut = await startSut(
        false,
        { SLACK_DISABLE: "true" },
        {},
        undefined,
        "postgres",
        async (s) => {
          const url = new URL(s.env.DATABASE_URL as string);
          held.proxy = await startBlackholeProxy(url.hostname, Number(url.port || 5432));
          url.hostname = "127.0.0.1";
          url.port = String(held.proxy.port);
          s.env.DATABASE_URL = url.toString();
        },
      );
      const live = sut;
      const proxy = held.proxy;
      expect(proxy, "The proxy did not start");
      const api = createApiClient(live.baseUrl, live.apiKey);
      const created = await api("POST", "/api/tasks", {
        body: { task: `dead connections ${ctx.nonce}`, followUpConfig: { disabled: true } },
      });
      expectStatus(created, [201], "create a task before the cut");
      const taskId = asString(asRecord(created.json).id, "created task id");
      // Open several pool connections, so the cut leaves more than one dead.
      await Promise.all(Array.from({ length: 4 }, () => api("GET", "/api/tasks?limit=5")));

      proxy.cut();
      const cutAt = performance.now();
      const exitLimit = FAIL_WITHIN_MS + 15_000;
      const exited = Promise.race([
        live.process.exited.then((code) => ({ code, ms: performance.now() - cutAt })),
        Bun.sleep(exitLimit).then(() => null),
      ]);
      const [request, green, exit] = await Promise.all([
        settleMs(live, exitLimit),
        healthGreenMs(live, exitLimit),
        exited,
      ]);
      ctx.log(
        `after the cut: request ${request.outcome} at ${Math.round(request.ms)} ms, /health green for ${Math.round(green)} ms, ` +
          (exit
            ? `API exited ${exit.code} at ${Math.round(exit.ms)} ms`
            : `API still running at ${exitLimit} ms`),
      );
      expect(
        request.outcome !== "still open" && request.ms <= FAIL_WITHIN_MS,
        `A database request on dead connections must fail within ${FAIL_WITHIN_MS} ms: ${request.outcome} after ${Math.round(request.ms)} ms`,
      );
      expect(
        green <= FAIL_WITHIN_MS,
        `/health stayed 200 for ${Math.round(green)} ms on dead database connections`,
      );
      expect(
        exit !== null && exit.code !== 0 && exit.ms <= FAIL_WITHIN_MS,
        `The API must exit non-zero within ${FAIL_WITHIN_MS} ms when its lock session is dead`,
      );
      expect(
        await live.drains.then(async () =>
          (await Bun.file(live.logPath).text()).includes("lost the one-process lock"),
        ),
        "The API must log why it exits",
      );

      // The database is back (the dead connections stay dead). A supervisor restarts the API.
      proxy.heal();
      const healedAt = performance.now();
      let restarted = false;
      while (!restarted && performance.now() - healedAt < RECOVER_WITHIN_MS) {
        restarted = await restartSut(live).then(
          () => true,
          () => false,
        );
      }
      expect(restarted, `The API did not start again within ${RECOVER_WITHIN_MS} ms`);
      const read = await api("GET", `/api/tasks/${taskId}`);
      const recoveredMs = performance.now() - healedAt;
      ctx.log(`after the heal: task read ${read.status} at ${Math.round(recoveredMs)} ms`);
      expectStatus(read, [200], "read the task after recovery");
      expect(
        recoveredMs <= RECOVER_WITHIN_MS,
        `The API served the database again after ${Math.round(recoveredMs)} ms`,
      );
    } finally {
      try {
        if (sut) await stopSut(sut, false);
      } finally {
        held.proxy?.stop();
      }
    }
  },
};
