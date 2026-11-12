import { createHmac } from "node:crypto";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  cleanupStack,
  deleteConfig,
  hmacSignature,
  putConfig,
  reloadConfig,
} from "./platform-helpers";
import { registerLead, registerWorker, retireAgent } from "./platformb-helpers";

// Inbound provider webhooks. Every provider is off in the test SUT, so each route must first
// answer its disabled contract (503). The shared secret is then supplied through swarm_config
// (stored values win over the deployment env), the integrations are reloaded, and the real
// signature checks run: missing and wrong signatures are 401, a bad body is 400, a verified
// delivery is handled. Config rows are removed and the 503 contract is asserted again at the end.

const WEBHOOKS = [
  "/api/github/webhook",
  "/api/gitlab/webhook",
  "/api/azure-devops/webhook",
  "/api/bitbucket/webhook",
  "/api/agentmail/webhook",
  "/api/integrations/kapso/webhook",
] as const;

const NOT_CONFIGURED: Record<(typeof WEBHOOKS)[number], string> = {
  "/api/github/webhook": "GitHub integration not configured",
  "/api/gitlab/webhook": "GitLab integration not configured",
  "/api/azure-devops/webhook": "Azure DevOps integration not configured",
  "/api/bitbucket/webhook": "Bitbucket integration not configured",
  "/api/agentmail/webhook": "AgentMail integration not configured",
  "/api/integrations/kapso/webhook": "Kapso integration not configured",
};

/** Standard Webhooks / Svix signature headers for an AgentMail delivery. */
function svixHeaders(secret: string, body: string): Record<string, string> {
  const id = `msg_e2e_${Math.random().toString(16).slice(2, 10)}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
}

/**
 * Verified AgentMail deliveries reach task routing. The sender is linked to a user only when
 * AgentMail authenticated it, and the sender filter reads the mailbox, not the display name.
 */
async function checkAgentMailSenders(
  ctx: ScenarioContext,
  secret: string,
  domain: string,
): Promise<void> {
  const boss = await ctx.api("POST", "/api/users", {
    body: { name: `Boss ${ctx.nonce}`, email: `boss@${domain}`, role: "admin" },
  });
  expectStatus(boss, [200], "create the user the mail names");
  const bossId = String(asRecord(asRecord(boss.json).user).id);
  const leadId = await registerLead(ctx, `e2e-agentmail-lead-${ctx.nonce}`);
  try {
    const deliver = async (eventType: string, from: string | string[], subject: string) => {
      const body = JSON.stringify({
        event_type: eventType,
        event_id: `evt_${subject}`,
        message: {
          inbox_id: `inb_${ctx.nonce}`,
          thread_id: `thr_${subject}`,
          message_id: `msg_${subject}`,
          from_: Array.isArray(from) ? from : [from],
          to: [`inb_${ctx.nonce}@agentmail.to`],
          labels: eventType.endsWith(".unauthenticated") ? ["unauthenticated"] : [],
          subject,
          text: "hello",
        },
      });
      const response = await ctx.api("POST", "/api/agentmail/webhook", {
        apiKey: null,
        rawBody: body,
        headers: svixHeaders(secret, body),
      });
      expectStatus(response, [200], `agentmail ${subject}`);
    };
    const taskFor = (subject: string) =>
      ctx.db.get<{ requestedByUserId: string | null; task: string }>(
        "SELECT requestedByUserId, task FROM agent_tasks WHERE task LIKE ?",
        [`%Subject: ${subject}%`],
      );
    const waitForTask = async (subject: string) => {
      expect(
        await pollUntil(() => taskFor(subject) !== null, 10_000),
        `a task for ${subject} never appeared`,
      );
      return taskFor(subject);
    };
    const merges = () =>
      ctx.db.query("SELECT 1 FROM user_identity_events WHERE userId = ? AND eventType = ?", [
        bossId,
        "auto_merge",
      ]).length;

    // The mailbox is the trailing <...>; an address inside the display name is ignored.
    const quoted = `quoted-${ctx.nonce}`;
    await deliver("message.received", `"Boss <boss@${domain}>" <other@elsewhere.test>`, quoted);
    // Only the first From entry is the sender; a later allowed entry does not let it through.
    const second = `second-${ctx.nonce}`;
    await deliver(
      "message.received",
      ["Other <other@elsewhere.test>", `Boss <boss@${domain}>`],
      second,
    );
    const signed = `signed-${ctx.nonce}`;
    await deliver("message.received", `Boss <boss@${domain}>`, signed);
    expect((await waitForTask(signed))?.requestedByUserId === bossId, "signed mail is linked");
    expect(merges() === 1, `signed mail links the user once, got ${merges()}`);
    expect(taskFor(quoted) === null, "the sender filter reads the mailbox, not the display name");
    expect(taskFor(second) === null, "the sender filter reads the first From entry only");

    // A sender AgentMail could not authenticate still reaches the lead, unlinked.
    const unsigned = `unsigned-${ctx.nonce}`;
    await deliver("message.received.unauthenticated", `Boss <boss@${domain}>`, unsigned);
    const task = await waitForTask(unsigned);
    expect(task?.requestedByUserId === null, "unauthenticated mail is not linked to a user");
    expect(
      task?.task.includes(`From: email:boss@${domain} (unknown user)`) === true,
      `unauthenticated mail shows the address as unknown, got ${task?.task}`,
    );
    expect(merges() === 1, `unauthenticated mail adds no identity event, got ${merges()}`);
  } finally {
    await retireAgent(ctx, leadId);
  }
}

async function expectDisabled(ctx: ScenarioContext, label: string) {
  for (const path of WEBHOOKS) {
    const response = await ctx.api("POST", path, { apiKey: null, body: { ping: label } });
    expectStatus(response, [503], `${label}: ${path}`);
    expect(
      asRecord(response.json).error === NOT_CONFIGURED[path],
      `${label}: ${path} says it is not configured, got ${response.text}`,
    );
  }
}

export const platformWebhooks: Scenario = {
  name: "platform-webhooks",
  order: 644,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const secret = (name: string) => `e2e-${name}-${ctx.nonce}`;
    const rows: string[] = [];
    const set = async (key: string, value: string, isSecret = false) => {
      const row = await putConfig(ctx, { key, value, isSecret });
      rows.push(String(row.id));
      cleanup.add(`delete ${key}`, async () => {
        await ctx.api("DELETE", `/api/config/${String(row.id)}`);
      });
    };
    try {
      // Webhook receivers authenticate with the provider's signature, not the swarm key.
      await expectDisabled(ctx, "before configuring");

      // Worker GitHub App tokens: only a registered agent may ask, and with no App
      // installation configured the answer is 404 so workers keep GITHUB_TOKEN.
      const tokenPath = "/api/github/installation-token";
      expectStatus(
        await ctx.api("POST", tokenPath, { apiKey: null, body: {} }),
        [401],
        "installation-token without a key",
      );
      expectStatus(
        await ctx.api("POST", tokenPath, { body: {} }),
        [403],
        "installation-token without an agent",
      );
      const workerId = await registerWorker(ctx, `e2e-gh-token-${ctx.nonce}`);
      const unconfigured = await ctx.api("POST", tokenPath, { agentId: workerId, body: {} });
      expectStatus(unconfigured, [404], "installation-token with no App installation");
      expect(
        asRecord(unconfigured.json).error === "GitHub App worker auth is not configured",
        `installation-token says it is not configured, got ${unconfigured.text}`,
      );

      const agentmailSecret = `whsec_${Buffer.from(`e2e-agentmail-secret-${ctx.nonce}`).toString("base64")}`;
      await set("GITLAB_WEBHOOK_SECRET", secret("gitlab"), true);
      await set("BITBUCKET_WEBHOOK_SECRET", secret("bitbucket"), true);
      await set("AZURE_DEVOPS_WEBHOOK_SECRET", secret("azure"), true);
      await set("GITHUB_DISABLE", "false");
      await set("GITHUB_WEBHOOK_SECRET", secret("github"), true);
      await set("AGENTMAIL_DISABLE", "false");
      await set("AGENTMAIL_WEBHOOK_SECRET", agentmailSecret, true);
      const mailDomain = `corp-${ctx.nonce}.test`;
      await set("AGENTMAIL_SENDER_DOMAIN_FILTER", mailDomain);
      await set("KAPSO_WEBHOOK_HMAC_SECRET", secret("kapso"), true);
      const reloaded = await reloadConfig(ctx);
      const reinitialized = reloaded.integrationsReinitialized as string[];
      for (const name of ["github", "gitlab", "azure-devops", "bitbucket", "agentmail"]) {
        expect(reinitialized.includes(name), `reload re-initializes ${name}, got ${reinitialized}`);
      }

      // ── GitHub ─────────────────────────────────────────────────────────────
      const ping = JSON.stringify({ zen: "keep it logically awesome" });
      const github = (body: string, headers: Record<string, string>) =>
        ctx.api("POST", "/api/github/webhook", { apiKey: null, rawBody: body, headers });
      const githubSig = (body: string) => hmacSignature(secret("github"), body);
      const noSignature = await github(ping, { "X-GitHub-Event": "ping" });
      expectStatus(noSignature, [401], "github without a signature");
      expect(
        asRecord(noSignature.json).error === "Invalid signature",
        "github says the signature is invalid",
      );
      expectStatus(
        await github(ping, { "X-GitHub-Event": "ping", "X-Hub-Signature-256": "sha256=deadbeef" }),
        [401],
        "github with a wrong signature",
      );
      expectStatus(
        await github(ping, {
          "X-GitHub-Event": "ping",
          "X-Hub-Signature-256": hmacSignature("another-secret", ping),
        }),
        [401],
        "github signed with another secret",
      );
      const pong = await github(ping, {
        "X-GitHub-Event": "ping",
        "X-Hub-Signature-256": githubSig(ping),
      });
      expectStatus(pong, [200], "github ping");
      expect(asRecord(pong.json).message === "pong", "a verified ping answers pong");
      const badJson = "not json";
      expectStatus(
        await github(badJson, {
          // A handled event: unhandled ones are acked before the body is read.
          "X-GitHub-Event": "pull_request",
          "X-Hub-Signature-256": githubSig(badJson),
        }),
        [400],
        "github with a signed non-json body",
      );
      const star = JSON.stringify({ action: "created" });
      const ignored = await github(star, {
        "X-GitHub-Event": "star",
        "X-Hub-Signature-256": githubSig(star),
      });
      expectStatus(ignored, [200], "github with an unhandled event");
      expect(asRecord(ignored.json).created === false, "an unhandled event creates no task");

      // ── GitLab ─────────────────────────────────────────────────────────────
      const push = JSON.stringify({ object_kind: "push" });
      const gitlab = (body: string, token?: string) =>
        ctx.api("POST", "/api/gitlab/webhook", {
          apiKey: null,
          rawBody: body,
          headers: token === undefined ? {} : { "X-Gitlab-Token": token },
        });
      const noToken = await gitlab(push);
      expectStatus(noToken, [401], "gitlab without a token");
      expect(asRecord(noToken.json).error === "Invalid token", "gitlab says the token is invalid");
      expectStatus(await gitlab(push, "wrong-token"), [401], "gitlab with a wrong token");
      expectStatus(
        await gitlab(push, secret("gitlab").slice(0, -1)),
        [401],
        "gitlab with a truncated token",
      );
      const gitlabOk = await gitlab(push, secret("gitlab"));
      expectStatus(gitlabOk, [200], "gitlab with the right token");
      expect(
        asRecord(gitlabOk.json).created === false,
        "an unhandled gitlab event creates no task",
      );
      expectStatus(
        await gitlab("not json", secret("gitlab")),
        [400],
        "gitlab with a non-json body",
      );

      // ── Azure DevOps ───────────────────────────────────────────────────────
      const hook = JSON.stringify({ eventType: "build.complete" });
      const basic = (password: string) =>
        `Basic ${Buffer.from(`hook:${password}`).toString("base64")}`;
      const azure = (body: string, authorization?: string) =>
        ctx.api("POST", "/api/azure-devops/webhook", {
          apiKey: null,
          rawBody: body,
          headers: authorization === undefined ? {} : { Authorization: authorization },
        });
      const azureNone = await azure(hook);
      expectStatus(azureNone, [401], "azure devops without credentials");
      expect(
        asRecord(azureNone.json).error === "Invalid credentials",
        "azure devops says the credentials are invalid",
      );
      expectStatus(await azure(hook, basic("wrong")), [401], "azure devops with a wrong password");
      expectStatus(
        await azure(hook, `Bearer ${secret("azure")}`),
        [401],
        "azure devops with a bearer instead of basic",
      );
      const azureOk = await azure(hook, basic(secret("azure")));
      expectStatus(azureOk, [200], "azure devops with the right password");
      expect(
        asRecord(azureOk.json).created === false,
        "an unsupported azure event creates no task",
      );
      expectStatus(
        await azure("not json", basic(secret("azure"))),
        [400],
        "azure devops with a non-json body",
      );

      // ── Bitbucket ──────────────────────────────────────────────────────────
      const bitbucketBody = JSON.stringify({ repository: { full_name: "acme/app" } });
      const bitbucket = (body: string | Uint8Array, signature?: string) =>
        ctx.api("POST", "/api/bitbucket/webhook", {
          apiKey: null,
          rawBody: body,
          headers: {
            "X-Event-Key": "repo:push",
            ...(signature === undefined ? {} : { "X-Hub-Signature": signature }),
          },
        });
      const bitbucketNone = await bitbucket(bitbucketBody);
      expectStatus(bitbucketNone, [401], "bitbucket without a signature");
      expect(
        asRecord(bitbucketNone.json).error === "Invalid signature",
        "bitbucket says the signature is invalid",
      );
      expectStatus(
        await bitbucket(bitbucketBody, "sha256=deadbeef"),
        [401],
        "bitbucket with a wrong signature",
      );
      expectStatus(
        await bitbucket(
          bitbucketBody,
          createHmac("sha1", secret("bitbucket")).update(bitbucketBody).digest("hex"),
        ),
        [401],
        "bitbucket with an unprefixed signature",
      );
      const bitbucketOk = await bitbucket(
        bitbucketBody,
        hmacSignature(secret("bitbucket"), bitbucketBody),
      );
      expectStatus(bitbucketOk, [200], "bitbucket with the right signature");
      expect(
        asRecord(bitbucketOk.json).created === false,
        "an unhandled bitbucket event creates no task",
      );
      expectStatus(
        await bitbucket("not json", hmacSignature(secret("bitbucket"), "not json")),
        [400],
        "bitbucket with a signed non-json body",
      );
      const oversized = new Uint8Array(1024 * 1024 + 4096).fill(97);
      expectStatus(
        await bitbucket(oversized, "sha256=00"),
        [413],
        "bitbucket with a body over 1 MiB",
      );

      // ── AgentMail (Svix) ───────────────────────────────────────────────────
      const mail = JSON.stringify({
        event_type: "message.received",
        event_id: `evt_${ctx.nonce}`,
        message: {
          inbox_id: `inb_${ctx.nonce}`,
          message_id: `msg_${ctx.nonce}`,
          from_: ["sender@example.com"],
          to: [`inb_${ctx.nonce}@agentmail.to`],
          subject: "e2e",
          text: "hello",
        },
      });
      const agentmail = (body: string, headers: Record<string, string>) =>
        ctx.api("POST", "/api/agentmail/webhook", { apiKey: null, rawBody: body, headers });
      expectStatus(await agentmail(mail, {}), [401], "agentmail without svix headers");
      const wrong = svixHeaders(agentmailSecret, mail);
      expectStatus(
        await agentmail(mail, { ...wrong, "svix-signature": "v1,AAAA" }),
        [401],
        "agentmail with a wrong signature",
      );
      expectStatus(
        await agentmail(
          mail,
          svixHeaders(`whsec_${Buffer.from("another-secret").toString("base64")}`, mail),
        ),
        [401],
        "agentmail signed with another secret",
      );
      // A verified delivery must be archived before it is acknowledged. This one has no
      // thread ID, so it cannot be archived and the sender is told to retry.
      const archived = await agentmail(mail, svixHeaders(agentmailSecret, mail));
      expectStatus(archived, [503], "agentmail with a verified signature");
      expect(
        asRecord(archived.json).error === "Inbound archive unavailable",
        "a verified delivery that cannot be archived asks for a retry",
      );

      await checkAgentMailSenders(ctx, agentmailSecret, mailDomain);

      // ── Kapso (HMAC secret read straight from config) ──────────────────────
      const kapso = (body: string, signature?: string) =>
        ctx.api("POST", "/api/integrations/kapso/webhook", {
          apiKey: null,
          rawBody: body,
          headers: signature === undefined ? {} : { "X-Webhook-Signature": signature },
        });
      const inbound = (id: string, direction: string, phoneNumberId = `pn-${ctx.nonce}`) =>
        JSON.stringify({
          phone_number_id: phoneNumberId,
          conversation: { id: `conv-${ctx.nonce}` },
          message: {
            id,
            from: "34600000000",
            type: "text",
            text: { body: "hi" },
            kapso: { direction },
          },
        });
      const kapsoNone = await kapso(inbound(`wamid-a-${ctx.nonce}`, "inbound"));
      expectStatus(kapsoNone, [401], "kapso without a signature");
      expect(
        asRecord(kapsoNone.json).error === "Invalid signature",
        "kapso says the signature is invalid",
      );
      expectStatus(
        await kapso(inbound(`wamid-a-${ctx.nonce}`, "inbound"), "sha256=deadbeef"),
        [401],
        "kapso with a wrong signature",
      );
      expectStatus(
        await kapso("not json", hmacSignature(secret("kapso"), "not json")),
        [400],
        "kapso with a signed non-json body",
      );
      const outbound = inbound(`wamid-out-${ctx.nonce}`, "outbound");
      const skipped = await kapso(outbound, hmacSignature(secret("kapso"), outbound));
      expectStatus(skipped, [200], "kapso outbound event");
      expect(asRecord(skipped.json).routing === "skip", "an outbound event is skipped");
      const unmapped = inbound(`wamid-b-${ctx.nonce}`, "inbound");
      const first = await kapso(unmapped, hmacSignature(secret("kapso"), unmapped));
      expectStatus(first, [200], "kapso inbound for an unregistered number");
      expect(
        asRecord(first.json).routing === "no_mapping",
        "an unregistered number has no routing",
      );
      const replay = await kapso(unmapped, hmacSignature(secret("kapso"), unmapped));
      expect(
        asRecord(replay.json).routing === "duplicate",
        "a redelivered message is deduplicated",
      );
      expect(
        ctx.db.get(
          "SELECT 1 AS one FROM agent_tasks WHERE taskType = 'kapso-inbound' AND task LIKE ?",
          [`%${ctx.nonce}%`],
        ) === null,
        "an unrouted message creates no task",
      );

      // ── back to the disabled contract ──────────────────────────────────────
      for (const id of rows.splice(0)) await deleteConfig(ctx, id);
      await reloadConfig(ctx);
      let restored = false;
      await pollUntil(
        async () => {
          const probe = await ctx.api("POST", "/api/gitlab/webhook", {
            apiKey: null,
            rawBody: push,
          });
          restored = probe.status === 503;
          return restored;
        },
        5_000,
        100,
      );
      expect(restored, "removing the secrets disables the gitlab webhook again");
      await expectDisabled(ctx, "after removing the config");
    } finally {
      await cleanup.run();
      try {
        await reloadConfig(ctx);
      } catch {
        // The run already failed; the reload is best effort.
      }
    }
  },
};
