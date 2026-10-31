import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { cleanupStack, putConfig, reloadConfig } from "./platform-helpers";

// First-run onboarding: the state machine behind the dashboard setup flow, the embeddings
// probe that saves a memory configuration, and the telemetry relay routes.

type Step = { status: string; at: string | null; method: string | null; errorClass: string | null };

async function onboarding(ctx: ScenarioContext) {
  const response = await ctx.api("GET", "/api/onboarding");
  expectStatus(response, [200], "get onboarding");
  return asRecord(response.json);
}

async function transition(ctx: ScenarioContext, body: Record<string, unknown>, label: string) {
  const response = await ctx.api("PUT", "/api/onboarding", { body });
  expectStatus(response, [200], label);
  return asRecord(response.json);
}

function stepsOf(payload: Record<string, unknown>): Record<string, Step> {
  return asRecord(asRecord(payload.state).steps) as unknown as Record<string, Step>;
}

export const platformOnboarding: Scenario = {
  name: "platform-onboarding",
  order: 642,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    try {
      expectStatus(await ctx.api("GET", "/api/onboarding", { apiKey: null }), [401], "get unauth");
      expectStatus(
        await ctx.api("PUT", "/api/onboarding", { apiKey: null, body: { action: "resume" } }),
        [401],
        "put unauth",
      );
      expectStatus(
        await ctx.api("POST", "/api/onboarding/memory", {
          apiKey: null,
          body: { preset: "existing" },
        }),
        [401],
        "memory unauth",
      );

      // ── state and live signals ─────────────────────────────────────────────
      const initial = await onboarding(ctx);
      const state = asRecord(initial.state);
      const steps = stepsOf(initial);
      expect(
        state.version === 1 &&
          typeof state.startedAt === "string" &&
          typeof state.currentStep === "string",
        "state carries version, start time and current step",
      );
      for (const name of [
        "connect",
        "name",
        "ai",
        "agents",
        "memory",
        "integrations",
        "files",
        "first_task",
      ]) {
        expect(steps[name] && typeof steps[name].status === "string", `step ${name} exists`);
      }
      expect(
        steps.connect?.status === "done" && steps.connect.method === "api_key",
        "reaching the API completes the connect step",
      );
      const signals = asRecord(initial.signals);
      const embeddings = asRecord(signals.embeddings);
      expect(Array.isArray(signals.providers), "signals list the harness providers");
      expect(
        embeddings.configured === true &&
          embeddings.dimensions === 512 &&
          typeof embeddings.model === "string",
        `signals report the embeddings setup: ${JSON.stringify(embeddings)}`,
      );
      expect(
        embeddings.local === true && embeddings.provider === "local",
        "a loopback embeddings endpoint counts as local",
      );
      const integrations = asRecord(signals.integrations);
      for (const name of ["slack", "github", "gitlab", "bitbucket", "linear", "jira"]) {
        expect(typeof integrations[name] === "boolean", `signals report whether ${name} is set up`);
      }
      expect(
        typeof asRecord(signals.agents).workersOnline === "number" &&
          typeof asRecord(signals.agents).leadsOnline === "number",
        "signals count online agents",
      );
      expect(
        signals.firstTask === null || typeof asRecord(signals.firstTask).id === "string",
        "signals carry the first task or null",
      );
      expect(
        typeof asRecord(signals.files).enabled === "boolean",
        "signals say whether files are enabled",
      );
      expect(
        ctx.db.get<{ value: string }>(
          "SELECT value FROM swarm_config WHERE key = 'onboarding_state'",
        ) !== null,
        "the state is stored in swarm_config",
      );

      // ── transitions ────────────────────────────────────────────────────────
      const viewed = await transition(ctx, { action: "view", step: "name" }, "view a step");
      expect(asRecord(viewed.state).currentStep === "name", "view moves the current step");
      const named = await transition(
        ctx,
        { action: "complete", step: "name", method: "custom_name" },
        "complete a step",
      );
      expect(
        stepsOf(named).name?.status === "done" &&
          stepsOf(named).name?.method === "custom_name" &&
          stepsOf(named).name?.at,
        "complete records status, method and time",
      );
      const failed = await transition(
        ctx,
        { action: "fail", step: "ai", errorClass: "auth" },
        "fail a step",
      );
      expect(
        stepsOf(failed).ai?.status === "failed" && stepsOf(failed).ai?.errorClass === "auth",
        "fail records the error class",
      );
      const fixed = await transition(
        ctx,
        { action: "complete", step: "ai", method: "openrouter" },
        "complete a failed step",
      );
      expect(
        stepsOf(fixed).ai?.status === "done" && stepsOf(fixed).ai?.errorClass === null,
        "completing a failed step clears its error",
      );
      const skipped = await transition(ctx, { action: "skip", step: "agents" }, "skip a step");
      expect(stepsOf(skipped).agents?.status === "skipped", "skip records a skipped step");
      const minimized = await transition(ctx, { action: "minimize" }, "minimize");
      expect(
        typeof asRecord(minimized.state).minimizedAt === "string",
        "minimize stamps minimizedAt",
      );
      const resumed = await transition(ctx, { action: "resume" }, "resume");
      expect(
        asRecord(resumed.state).minimizedAt === null &&
          asRecord(resumed.state).dismissedAt === null,
        "resume clears minimizedAt and dismissedAt",
      );
      const dismissed = await transition(ctx, { action: "dismiss" }, "dismiss");
      expect(
        typeof asRecord(dismissed.state).dismissedAt === "string",
        "dismiss stamps dismissedAt",
      );
      await transition(ctx, { action: "resume" }, "resume after dismiss");

      // The persisted state is what a fresh read sees.
      const reread = stepsOf(await onboarding(ctx));
      expect(
        reread.name?.method === "custom_name" &&
          reread.ai?.status === "done" &&
          reread.agents?.status === "skipped",
        "a fresh read returns the persisted steps",
      );

      const invalid: Array<[Record<string, unknown>, string]> = [
        [{ action: "bogus" }, "an unknown action"],
        [{ action: "view", step: "nowhere" }, "an unknown step"],
        [{ action: "complete", step: "name", method: "bogus" }, "a method the step does not offer"],
        [
          { action: "complete", step: "connect", method: "custom_name" },
          "a method of another step",
        ],
        [{ action: "skip", step: "connect" }, "skipping the connect step"],
        [{ action: "fail", step: "ai", errorClass: "gremlins" }, "an unknown error class"],
        [{ action: "first_task", method: "suggestion" }, "first_task without a task id"],
        [{}, "an empty body"],
      ];
      for (const [body, label] of invalid) {
        expectStatus(await ctx.api("PUT", "/api/onboarding", { body }), [400], `put ${label}`);
      }

      // The first task must exist.
      expectStatus(
        await ctx.api("PUT", "/api/onboarding", {
          body: { action: "first_task", taskId: crypto.randomUUID(), method: "suggestion" },
        }),
        [404],
        "first_task with an unknown task",
      );
      const task = await ctx.api("POST", "/api/tasks", {
        body: { task: `onboarding first task ${ctx.nonce}`, source: "api" },
      });
      expectStatus(task, [201], "create the first task");
      const taskId = String(asRecord(task.json).id);
      const withTask = await transition(
        ctx,
        { action: "first_task", taskId, method: "free_form" },
        "first_task",
      );
      expect(asRecord(withTask.state).firstTaskId === taskId, "first_task records the task id");
      expect(
        asRecord(asRecord(withTask.signals).firstTask).id === taskId,
        "the signals follow the first task",
      );
      expect(
        stepsOf(withTask).first_task?.method === "free_form",
        "first_task completes its step with the method",
      );

      // ── embeddings probe ───────────────────────────────────────────────────
      const memory = (body: Record<string, unknown>) =>
        ctx.api("POST", "/api/onboarding/memory", { body });
      const embeddingKeys = ["EMBEDDING_API_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_API_KEY"];
      const storedEmbeddingRows = () =>
        ctx.db.query<{ key: string }>(
          "SELECT key FROM swarm_config WHERE scope = 'global' AND key IN (?, ?, ?)",
          embeddingKeys,
        );
      const before = storedEmbeddingRows().length;
      for (const [body, label] of [
        [{ preset: "bogus" }, "an unknown preset"],
        [{ preset: "custom", baseUrl: "ftp://example.com" }, "a non-http base url"],
        [{ preset: "custom", restoreDefault: true }, "restoreDefault without the existing preset"],
        [{ preset: "custom", surprise: true }, "an unknown field"],
      ] as const) {
        expectStatus(await memory(body), [400], `memory with ${label}`);
      }
      const noKey = await memory({ preset: "custom", baseUrl: `${ctx.llm.origin}/v1` });
      expectStatus(noKey, [200], "memory without a key");
      expect(
        asRecord(noKey.json).ok === false && asRecord(noKey.json).errorClass === "auth",
        "a missing key is an auth failure, answered 200",
      );
      const unreachable = await memory({
        preset: "custom",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "k-e2e",
      });
      expectStatus(unreachable, [200], "memory with an unreachable endpoint");
      expect(
        asRecord(unreachable.json).ok === false &&
          asRecord(unreachable.json).errorClass === "network",
        "an unreachable endpoint is a network failure",
      );
      expect(
        stepsOf(await onboarding(ctx)).memory?.status === "failed" &&
          stepsOf(await onboarding(ctx)).memory?.errorClass === "network",
        "a failed probe marks the memory step failed",
      );
      expect(storedEmbeddingRows().length === before, "a failed probe saves no configuration");

      cleanup.add("restore the embeddings configuration", async () => {
        await ctx.api("POST", "/api/onboarding/memory", {
          body: { preset: "existing", restoreDefault: true },
        });
      });
      const saved = await memory({
        preset: "custom",
        baseUrl: `${ctx.llm.origin}/v1`,
        apiKey: `k-${ctx.nonce}`,
        model: "text-embedding-3-small",
      });
      expectStatus(saved, [200], "memory with a working endpoint");
      expect(
        asRecord(saved.json).ok === true &&
          asRecord(saved.json).dimensions === 512 &&
          typeof asRecord(saved.json).latencyMs === "number",
        "a working endpoint answers its dimensions",
      );
      expect(
        ctx.llm
          .requestsTo("/embeddings")
          .some((r) => JSON.stringify(r.body ?? r).includes("onboarding probe")),
        "the probe sent an embeddings request to the endpoint",
      );
      const savedRows = asRecords(
        (await ctx.api("GET", "/api/config?scope=global&key=EMBEDDING_API_KEY")).json,
        "configs",
      );
      expect(
        savedRows[0]?.isSecret === true && savedRows[0]?.value === "********",
        "the probe saves the key as a masked secret",
      );
      expect(
        asRecords(
          (await ctx.api("GET", "/api/config?scope=global&key=EMBEDDING_API_BASE_URL")).json,
          "configs",
        )[0]?.value === `${ctx.llm.origin}/v1`,
        "the probe saves the base url",
      );
      expect(
        stepsOf(await onboarding(ctx)).memory?.status === "done",
        "a working probe completes the memory step",
      );

      const restored = await memory({ preset: "existing", restoreDefault: true });
      expectStatus(restored, [200], "restore the deployment embeddings");
      expect(asRecord(restored.json).ok === true, "the deployment setup still works");
      expect(
        storedEmbeddingRows().length === before,
        "restoring deletes the stored embeddings configuration",
      );
      const existing = await memory({ preset: "existing" });
      expectStatus(existing, [200], "test the existing embeddings");
      expect(
        asRecord(existing.json).ok === true && asRecord(existing.json).dimensions === 512,
        "the existing setup answers its dimensions",
      );
    } finally {
      await cleanup.run();
    }
  },
};

export const platformTelemetry: Scenario = {
  name: "platform-telemetry",
  order: 643,
  async run(ctx) {
    expectStatus(
      await ctx.api("POST", "/api/telemetry/ui-event", {
        apiKey: null,
        body: { event: "ui.session_started" },
      }),
      [401],
      "ui-event unauth",
    );
    expectStatus(
      await ctx.api("POST", "/api/telemetry/enable", { apiKey: null, body: {} }),
      [401],
      "enable unauth",
    );

    // Telemetry is off in the test SUT: a valid, catalogued event is accepted and dropped.
    // The mock inference host doubles as the telemetry sink (DESPLEGA_TELEMETRY_ENDPOINT).
    const sink = () =>
      ctx.llm.requestsTo("/telemetry/v1/events").map((request) => asRecord(request.body));
    expect(sink().length === 0, "telemetry is off at boot: the sink has seen nothing");
    const accepted = await ctx.api("POST", "/api/telemetry/ui-event", {
      body: { event: "ui.session_started" },
    });
    expectStatus(accepted, [204], "relay a catalogued ui event");
    expect(accepted.text === "", "a relayed event has no body");
    expectStatus(
      await ctx.api("POST", "/api/telemetry/ui-event", {
        body: { event: "page.viewed", properties: { route_template: "/tasks/:id" } },
      }),
      [204],
      "relay an event with its required property",
    );

    const invalid: Array<[Record<string, unknown>, string]> = [
      [{}, "no event name"],
      [{ event: "" }, "an empty event name"],
      [{ event: "no.such_event" }, "an uncatalogued event"],
      [{ event: "page.viewed" }, "a missing required property"],
      [
        { event: "page.viewed", properties: { route_template: 42 } },
        "a property of the wrong type",
      ],
      [{ event: "x".repeat(65) }, "an event name over 64 chars"],
    ];
    for (const [body, label] of invalid) {
      expectStatus(
        await ctx.api("POST", "/api/telemetry/ui-event", { body }),
        [400],
        `ui-event with ${label}`,
      );
    }
    const unknown = await ctx.api("POST", "/api/telemetry/ui-event", {
      body: { event: "no.such_event" },
    });
    expect(
      String(asRecord(unknown.json).error).includes("unknown event"),
      "an uncatalogued event is named in the error",
    );
    const tooBig = await ctx.api("POST", "/api/telemetry/ui-event", {
      body: { event: "ui.session_started", properties: { filler: "x".repeat(9_000) } },
    });
    expect(
      tooBig.status === 400 || tooBig.status === 413,
      `a body over 8 KiB is refused, got ${tooBig.status}`,
    );

    expectStatus(
      await ctx.api("POST", "/api/telemetry/enable", { body: { via: "carrier-pigeon" } }),
      [400],
      "enable with an unknown via",
    );
    expect(sink().length === 0, "refused requests send nothing");

    // POST /api/telemetry/enable turns the real telemetry client on and sends `telemetry.enabled`
    // once. The sink is the mock, so nothing leaves the machine. The route stores the flag as a
    // global config row, and the cleanup stores it as `false`, because deleting the row would
    // restore the value the route set in the process environment.
    const cleanup = cleanupStack(ctx);
    cleanup.add("turn telemetry off", async () => {
      await putConfig(ctx, { key: "ANONYMIZED_TELEMETRY", value: "false" });
      await reloadConfig(ctx);
    });
    try {
      const enabled = await ctx.api("POST", "/api/telemetry/enable", {
        body: { via: "settings" },
      });
      expectStatus(enabled, [200], "turn telemetry on");
      expect(asRecord(enabled.json).enabled === true, "enable answers { enabled: true }");

      // The client sends without blocking the response, so wait for the sink.
      expect(
        await pollUntil(() => sink().some((body) => body.event === "telemetry.enabled"), 10_000),
        "telemetry.enabled reached the sink",
      );
      const first = sink().find((body) => body.event === "telemetry.enabled") ?? {};
      expect(
        first.schema_version === 2 && first.product === "agent-swarm",
        "the event carries the v2 envelope for agent-swarm",
      );
      expect(first.source === "api-server", `the event comes from the api-server: ${first.source}`);
      expect(asRecord(first.properties).via === "settings", "the event names the `via` we sent");
      expect(
        typeof first.actor_anonymous_id === "string" &&
          first.actor_anonymous_id.startsWith("install_"),
        "the event is pseudonymous: an install id, no user",
      );
      expect(
        typeof first.occurred_at === "string" && !Number.isNaN(Date.parse(first.occurred_at)),
        "the event carries an occurrence time",
      );
      expect(
        typeof asRecord(first.context).org_id === "string",
        "the event carries the org id in its context",
      );

      // With telemetry on, a relayed dashboard event reaches the sink with its properties.
      expectStatus(
        await ctx.api("POST", "/api/telemetry/ui-event", {
          body: { event: "page.viewed", properties: { route_template: "/tasks/:id" } },
        }),
        [204],
        "relay an event with telemetry on",
      );
      expect(
        await pollUntil(() => sink().some((body) => body.event === "page.viewed"), 10_000),
        "the relayed page.viewed reached the sink",
      );
      const relayed = sink().find((body) => body.event === "page.viewed") ?? {};
      expect(
        asRecord(relayed.properties).route_template === "/tasks/:id",
        "the relayed event keeps its properties",
      );
      expect(
        relayed.actor_anonymous_id === first.actor_anonymous_id,
        "both events carry the same install id",
      );
    } finally {
      await cleanup.run();
    }

    // The opt-out holds again: a relayed event is accepted and dropped.
    const sent = sink().length;
    expectStatus(
      await ctx.api("POST", "/api/telemetry/ui-event", {
        body: { event: "page.viewed", properties: { route_template: "/agents/:id" } },
      }),
      [204],
      "relay an event with telemetry back off",
    );
    await Bun.sleep(300);
    expect(sink().length === sent, "no event reaches the sink once telemetry is off again");
  },
};
