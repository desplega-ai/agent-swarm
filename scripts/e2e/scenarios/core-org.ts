import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";

type Captured = { path: string; body: Record<string, unknown> };

/** Global config rows this scenario created, deleted at the end. */
const createdConfig: string[] = [];

async function setGlobal(ctx: ScenarioContext, key: string, value: string): Promise<void> {
  const response = await ctx.api("PUT", "/api/config", {
    body: { scope: "global", scopeId: null, key, value, isSecret: false },
  });
  expectStatus(response, [200], `set ${key}`);
  createdConfig.push(String(asRecord(response.json).id));
}

async function clearConfig(ctx: ScenarioContext): Promise<void> {
  for (const id of createdConfig.splice(0)) {
    await ctx.api("DELETE", `/api/config/${id}`);
  }
}

function configRow(ctx: ScenarioContext, key: string) {
  return ctx.db.get<{ value: string; isSecret: number }>(
    "SELECT value, isSecret FROM swarm_config WHERE scope = 'global' AND key = ?",
    [key],
  );
}

/** A stand-in for the telemetry proxy the used-by grant is relayed to. */
function startProxy(status: () => number) {
  const received: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {}
      received.push({ path: url.pathname, body });
      return new Response("{}", {
        status: status(),
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { server, received, origin: `http://127.0.0.1:${server.port}` };
}

/** The "used by" logo consent: validation, the relay to the proxy, persistence, revocation. */
async function usedBy(ctx: ScenarioContext, website: string) {
  let proxyStatus = 200;
  const proxy = startProxy(() => proxyStatus);
  try {
    // Without an organization identity there is nothing to relay.
    let response = await ctx.api("POST", "/api/used-by", {
      body: { granted: true, contactEmail: `core-${ctx.nonce}@example.com` },
    });
    expectStatus(response, [400], "consent without an organization");
    expect(
      String(asRecord(response.json).error).includes("organization name and website"),
      "400 lacks the organization reason",
    );

    // Validation does not need an organization.
    for (const [body, label] of [
      [{}, "no granted flag"],
      [{ granted: true }, "grant without a contact email"],
      [{ granted: true, contactEmail: "not-an-email" }, "invalid contact email"],
      [
        { granted: true, contactEmail: "a@example.com", contactFunction: "wizard" },
        "unknown function",
      ],
      [{ granted: true, contactEmail: "a@example.com", quote: "q".repeat(281) }, "quote too long"],
    ] as const) {
      expectStatus(await ctx.api("POST", "/api/used-by", { body }), [400], `used-by: ${label}`);
    }
    expectStatus(
      await ctx.api("POST", "/api/used-by", { apiKey: null, body: { granted: false } }),
      [401],
      "used-by without credentials",
    );

    await setGlobal(ctx, "SWARM_ORG_NAME", `Core Org ${ctx.nonce}`);
    await setGlobal(ctx, "SWARM_ORG_WEBSITE", website);
    await setGlobal(ctx, "feedback_endpoint", `${proxy.origin}/v1/feedback`);

    // A proxy that refuses the grant surfaces as 502 and records nothing.
    proxyStatus = 503;
    response = await ctx.api("POST", "/api/used-by", {
      body: { granted: true, contactEmail: `core-${ctx.nonce}@example.com` },
    });
    expectStatus(response, [502], "the proxy refuses the grant");
    expect(String(asRecord(response.json).error).includes("503"), "502 lacks the proxy status");
    expect(configRow(ctx, "SWARM_USED_BY_CONSENT") === null, "A refused grant stored consent");

    proxyStatus = 200;
    response = await ctx.api("POST", "/api/used-by", {
      body: {
        granted: true,
        contactEmail: `core-${ctx.nonce}@example.com`,
        contactFunction: "engineer",
        quote: `Great tool ${ctx.nonce}`,
      },
    });
    expectStatus(response, [200], "grant consent");
    const granted = asRecord(response.json);
    expect(
      granted.granted === true && !Number.isNaN(Date.parse(String(granted.changedAt))),
      `Grant response ${response.text}`,
    );
    const relayed = proxy.received.at(-1);
    expect(
      relayed?.path === "/v1/used-by" &&
        relayed.body.granted === true &&
        relayed.body.org_name === `Core Org ${ctx.nonce}` &&
        relayed.body.org_website === website &&
        relayed.body.contact_email === `core-${ctx.nonce}@example.com` &&
        relayed.body.quote === `Great tool ${ctx.nonce}`,
      `The proxy received ${JSON.stringify(relayed)}`,
    );
    expect(configRow(ctx, "SWARM_USED_BY_CONSENT")?.value === "true", "Consent flag not stored");
    expect(
      configRow(ctx, "SWARM_USED_BY_CONTACT_EMAIL")?.isSecret === 1,
      "The contact email must be stored as a secret row",
    );

    // Revoking relays the same identity and clears the contact details.
    response = await ctx.api("POST", "/api/used-by", { body: { granted: false } });
    expectStatus(response, [200], "revoke consent");
    expect(asRecord(response.json).granted === false, "Revoke response");
    const revoked = proxy.received.at(-1);
    expect(
      revoked?.body.granted === false &&
        revoked.body.org_name === `Core Org ${ctx.nonce}` &&
        !("contact_email" in revoked.body),
      `Revocation relay ${JSON.stringify(revoked)}`,
    );
    expect(configRow(ctx, "SWARM_USED_BY_CONSENT")?.value === "false", "Consent not revoked");
    // The email is a secret row (encrypted at rest), so only the plain rows can show the clear.
    expect(configRow(ctx, "SWARM_USED_BY_QUOTE")?.value === "", "Quote not cleared by the revoke");
    expect(
      configRow(ctx, "SWARM_USED_BY_CONTACT_FUNCTION")?.value === "",
      "Contact function not cleared by the revoke",
    );

    // An unreachable proxy is also a 502.
    const closed = proxy.origin;
    await proxy.server.stop(true);
    response = await ctx.api("POST", "/api/used-by", { body: { granted: false } });
    expectStatus(response, [502], "the proxy is down");
    expect(
      String(asRecord(response.json).error).includes("Could not reach"),
      `Unreachable proxy error: ${response.text} (${closed})`,
    );
  } finally {
    await proxy.server.stop(true);
  }
}

/** The public ranking: state, the telemetry gate on opt-in, opt-out. */
async function ranking(ctx: ScenarioContext, website: string) {
  let response = await ctx.api("GET", "/api/ranking");
  expectStatus(response, [200], "ranking state");
  const state = asRecord(response.json);
  expect(
    state.telemetryOn === false &&
      state.eligible === false &&
      state.enabled === false &&
      state.name === `Core Org ${ctx.nonce}` &&
      state.domain === website &&
      Array.isArray(state.missing) &&
      state.missing.length === 0 &&
      state.listing === null,
    `Ranking state ${response.text}`,
  );

  // Opting in needs telemetry, which the test SUT turns off.
  response = await ctx.api("POST", "/api/ranking/opt-in", { body: { category: "engineering" } });
  expectStatus(response, [409], "opt in with telemetry off");
  expect(asRecord(response.json).error === "telemetry_off", `Opt-in 409 body ${response.text}`);
  expect(configRow(ctx, "PUBLIC_RANKING_ENABLED") === null, "A refused opt-in stored the flag");
  expectStatus(
    await ctx.api("POST", "/api/ranking/opt-in", { body: { category: "bogus" } }),
    [400],
    "opt in with an unknown category",
  );
  expectStatus(
    await ctx.api("POST", "/api/ranking/opt-in", { apiKey: null, body: { category: "other" } }),
    [401],
    "opt in without credentials",
  );

  response = await ctx.api("POST", "/api/ranking/opt-out");
  expectStatus(response, [200], "opt out");
  expect(asRecord(response.json).enabled === false, "Opt-out response");
  expect(
    configRow(ctx, "PUBLIC_RANKING_ENABLED")?.value === "false",
    "Opt-out did not store false",
  );
  response = await ctx.api("POST", "/api/ranking/opt-out");
  expectStatus(response, [200], "opt out again");
  expectStatus(
    await ctx.api("POST", "/api/ranking/opt-out", { apiKey: null }),
    [401],
    "opt out without credentials",
  );
  expectStatus(
    await ctx.api("GET", "/api/ranking", { apiKey: null }),
    [401],
    "ranking unauthenticated",
  );
}

/** The fleet benchmark card: local numbers, and the level that follows the company profile. */
async function fleetBenchmark(ctx: ScenarioContext) {
  let response = await ctx.api("GET", "/api/fleet-benchmark");
  expectStatus(response, [200], "fleet benchmark");
  let card = asRecord(response.json);
  expect(
    card.state === "telemetry_off" && card.level === "basic",
    `Benchmark card ${response.text}`,
  );
  const local = asRecord(card.local);
  expect(
    typeof local.tasksPerWeek === "number" &&
      typeof local.finishedTasks === "number" &&
      Number(local.agents) >= 1 &&
      typeof local.bucket === "string",
    "The card lacks local figures",
  );
  expect(
    Array.isArray(card.comparisons) && card.comparisons.length === 0 && card.peerGroup === null,
    "Telemetry off must not produce comparisons",
  );
  expect(card.minFinishedTasks === 10, "minFinishedTasks changed");

  await setGlobal(ctx, "SWARM_ORG_TEAM_SIZE", "2-10");
  await setGlobal(ctx, "SWARM_ORG_USE_CASE", "features");
  response = await ctx.api("GET", "/api/fleet-benchmark");
  card = asRecord(response.json);
  expect(
    card.level === "full" && card.state === "telemetry_off",
    `Full-profile card ${response.text}`,
  );
  expectStatus(
    await ctx.api("GET", "/api/fleet-benchmark", { apiKey: null }),
    [401],
    "benchmark without credentials",
  );
}

export const coreOrg: Scenario = {
  name: "core-org",
  order: 265,
  async run(ctx) {
    const website = `core${ctx.nonce}.example.com`;
    try {
      await usedBy(ctx, website);
      await ranking(ctx, website);
      await fleetBenchmark(ctx);
    } finally {
      await clearConfig(ctx);
      // The ranking opt-out stored PUBLIC_RANKING_ENABLED; drop that row too.
      const flag = configRow(ctx, "PUBLIC_RANKING_ENABLED");
      if (flag !== null) {
        const row = ctx.db.get<{ id: string }>(
          "SELECT id FROM swarm_config WHERE scope = 'global' AND key = 'PUBLIC_RANKING_ENABLED'",
        );
        if (row) await ctx.api("DELETE", `/api/config/${row.id}`);
      }
      for (const key of [
        "SWARM_USED_BY_CONSENT",
        "SWARM_USED_BY_CONSENT_AT",
        "SWARM_USED_BY_ORG_NAME",
        "SWARM_USED_BY_ORG_WEBSITE",
        "SWARM_USED_BY_CONTACT_EMAIL",
        "SWARM_USED_BY_CONTACT_FUNCTION",
        "SWARM_USED_BY_QUOTE",
      ]) {
        const row = ctx.db.get<{ id: string }>(
          "SELECT id FROM swarm_config WHERE scope = 'global' AND key = ?",
          [key],
        );
        if (row) await ctx.api("DELETE", `/api/config/${row.id}`);
      }
    }
  },
};
