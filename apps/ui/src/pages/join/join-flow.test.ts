import { describe, expect, test } from "bun:test";
import {
  JOIN_COPY,
  JoinApiError,
  type JoinDeps,
  joinRedirect,
  parseJoinParams,
  runJoin,
  swarmHost,
  withoutJoinParams,
} from "./join-flow";

const CODE = "c".repeat(43);
const PARAMS = { swarm: "https://swarm.example.com", code: CODE };

interface Recorded {
  exchanged: Array<{ swarm: string; code: string }>;
  added: Array<{ name: string; apiUrl: string; apiKey: string }>;
  switched: string[];
}

function fakeDeps(overrides: Partial<JoinDeps> = {}): { deps: JoinDeps; rec: Recorded } {
  const rec: Recorded = { exchanged: [], added: [], switched: [] };
  const deps: JoinDeps = {
    connectionsManaged: () => false,
    exchange: async (swarm, code) => {
      rec.exchanged.push({ swarm, code });
      return { token: "aswt_teammate", userId: "u1" };
    },
    addConnection: (conn) => {
      rec.added.push(conn);
      return { id: "conn_new" };
    },
    switchConnection: (id) => {
      rec.switched.push(id);
    },
    combEnabled: async () => false,
    ...overrides,
  };
  return { deps, rec };
}

describe("parseJoinParams", () => {
  test("reads a code supplied only in the fragment", () => {
    expect(parseJoinParams(`?swarm=${encodeURIComponent(PARAMS.swarm)}`, `#code=${CODE}`)).toEqual(
      PARAMS,
    );
  });

  test("reads the fragment code before the query code", () => {
    expect(
      parseJoinParams(
        `?swarm=${encodeURIComponent("https://swarm.example.com/")}&code=old`,
        `#code=${CODE}`,
      ),
    ).toEqual(PARAMS);
  });

  test("reads the query code from older links and trims a trailing slash", () => {
    expect(
      parseJoinParams(`?swarm=${encodeURIComponent("https://swarm.example.com/")}&code=${CODE}`),
    ).toEqual(PARAMS);
  });

  test("rejects missing params and non-http swarms", () => {
    for (const search of [
      "",
      `?code=${CODE}`,
      "?swarm=https%3A%2F%2Fa.example.com",
      `?swarm=not-a-url&code=${CODE}`,
      `?swarm=${encodeURIComponent("javascript:alert(1)")}&code=${CODE}`,
      `?swarm=${encodeURIComponent("https://u:p@a.example.com")}&code=${CODE}`,
    ]) {
      expect(parseJoinParams(search)).toBeNull();
    }
  });
});

describe("withoutJoinParams", () => {
  test("drops swarm and code, keeps the rest", () => {
    expect(withoutJoinParams(`?swarm=x&code=${CODE}`)).toBe("");
    expect(withoutJoinParams(`?swarm=x&code=${CODE}&utm=1`)).toBe("?utm=1");
  });
});

describe("runJoin", () => {
  test("success saves a connection named after the host, activates it, and goes Home", async () => {
    const { deps, rec } = fakeDeps();
    const outcome = await runJoin(deps, PARAMS);
    expect(outcome).toEqual({ kind: "joined", redirect: "/", host: "swarm.example.com" });
    expect(rec.exchanged).toEqual([{ swarm: PARAMS.swarm, code: CODE }]);
    expect(rec.added).toEqual([
      { name: "swarm.example.com", apiUrl: PARAMS.swarm, apiKey: "aswt_teammate" },
    ]);
    expect(rec.switched).toEqual(["conn_new"]);
  });

  test("Comb on lands on /file?connect=auto", async () => {
    const seen: Array<{ swarm: string; token: string }> = [];
    const { deps } = fakeDeps({
      combEnabled: async (swarm, token) => {
        seen.push({ swarm, token });
        return true;
      },
    });
    const outcome = await runJoin(deps, PARAMS);
    expect(outcome).toMatchObject({ kind: "joined", redirect: "/file?connect=auto" });
    expect(seen).toEqual([{ swarm: PARAMS.swarm, token: "aswt_teammate" }]);
    expect(joinRedirect(true)).toBe("/file?connect=auto");
    expect(joinRedirect(false)).toBe("/");
  });

  test("a failed /status still lands on Home", async () => {
    const { deps } = fakeDeps({
      combEnabled: async () => {
        throw new JoinApiError("Request failed: 500", 500);
      },
    });
    expect(await runJoin(deps, PARAMS)).toMatchObject({ kind: "joined", redirect: "/" });
  });

  test("404 shows the expired copy and saves nothing", async () => {
    const { deps, rec } = fakeDeps({
      exchange: async () => {
        throw new JoinApiError("code_invalid", 404, "code_invalid");
      },
    });
    expect(await runJoin(deps, PARAMS)).toEqual({ kind: "invalid" });
    expect(rec.added).toEqual([]);
    expect(rec.switched).toEqual([]);
    expect(JOIN_COPY.invalid).toBe(
      "This invite link is used or expired. Ask the admin for a new one.",
    );
  });

  test("a baked deployment shows the managed message without spending the code", async () => {
    const { deps, rec } = fakeDeps({ connectionsManaged: () => true });
    expect(await runJoin(deps, PARAMS)).toEqual({ kind: "managed" });
    expect(rec.exchanged).toEqual([]);
    expect(JOIN_COPY.managed).toBe(
      "This dashboard is managed by its deployment. Open the invite in the dashboard of that swarm.",
    );
  });

  test("addConnection throwing (a baked deployment) shows the managed message", async () => {
    const { deps, rec } = fakeDeps({
      addConnection: () => {
        throw new Error("Connections are managed by this UI deployment.");
      },
    });
    expect(await runJoin(deps, PARAMS)).toEqual({ kind: "managed" });
    expect(rec.switched).toEqual([]);
  });

  test("network failures and rate limits can be retried; other errors cannot", async () => {
    const network = fakeDeps({
      exchange: async () => {
        throw new JoinApiError("Could not reach https://swarm.example.com.", null);
      },
    });
    expect(await runJoin(network.deps, PARAMS)).toMatchObject({ kind: "failed", retryable: true });
    const limited = fakeDeps({
      exchange: async () => {
        throw new JoinApiError("rate_limited", 429, "rate_limited");
      },
    });
    expect(await runJoin(limited.deps, PARAMS)).toMatchObject({ kind: "failed", retryable: true });
    const broken = fakeDeps({
      exchange: async () => {
        throw new JoinApiError("Failed to exchange code", 500);
      },
    });
    expect(await runJoin(broken.deps, PARAMS)).toEqual({
      kind: "failed",
      message: "Failed to exchange code",
      retryable: false,
    });
  });
});

describe("swarmHost", () => {
  test("is the host with its port", () => {
    expect(swarmHost("http://localhost:3013")).toBe("localhost:3013");
    expect(swarmHost("https://swarm.example.com")).toBe("swarm.example.com");
  });
});
