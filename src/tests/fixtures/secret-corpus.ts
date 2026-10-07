/**
 * Scrubber corpus: credential shapes that must redact, and real-looking
 * non-secrets that must survive untouched.
 *
 * Positives are built at runtime from random bytes, never written as
 * literals, so repo secret scanners and GitHub push protection never flag
 * this file. Negatives are deterministic (hash-derived where they need to look
 * random) so a false positive reproduces on every run.
 */
import { createHash, randomBytes } from "node:crypto";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const HEX = "0123456789abcdef";
const DIGITS = "0123456789";
const URLSAFE = `${ALNUM}_-`;

/** `len` random chars from `alphabet`. */
function rand(alphabet: string, len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[(bytes[i] as number) % alphabet.length];
  return out;
}

const join = (...parts: string[]) => parts.join("");

export interface CorpusPositive {
  /** Shape name, for test titles. */
  name: string;
  /** The credential itself; it must not survive `scrubSecrets`. */
  secret: string;
  /** The credential in context, as it would reach a log. */
  text: string;
  /** Set when pass 5 (gitleaks) is the pass that must catch it. */
  gitleaksRule?: string;
}

function positive(
  name: string,
  secret: string,
  opts: { context?: (secret: string) => string; gitleaksRule?: string } = {},
): CorpusPositive {
  const context = opts.context ?? ((s: string) => `the response included ${s} in its body`);
  return { name, secret, text: context(secret), gitleaksRule: opts.gitleaksRule };
}

/**
 * The vendor shapes an audit probe found unredacted after the structural
 * passes, plus the providers this repo integrates with.
 */
export function buildPositives(): CorpusPositive[] {
  return [
    // Audit probe shapes.
    positive("stripe secret key", join("sk", "_live_", rand(ALNUM, 24)), {
      gitleaksRule: "stripe-access-token",
    }),
    positive("stripe restricted key", join("rk", "_live_", rand(ALNUM, 24)), {
      gitleaksRule: "stripe-access-token",
    }),
    positive("sendgrid", join("SG", ".", rand(URLSAFE, 22), ".", rand(URLSAFE, 43)), {
      gitleaksRule: "sendgrid-api-token",
    }),
    positive("hugging face", join("hf", "_", rand(LOWER, 34)), {
      gitleaksRule: "huggingface-access-token",
    }),
    positive(
      "resend",
      join("re", "_", rand(DIGITS, 2), rand(UPPER_ALNUM, 6), "_", rand(ALNUM, 24)),
    ),
    positive("google oauth access token", join("ya29", ".", rand(URLSAFE, 120))),
    positive("google refresh token", join("1/", "/0", rand(URLSAFE, 100))),
    positive(
      "discord webhook",
      join("https://discord.com/api/", "webhooks/", rand(DIGITS, 18), "/", rand(URLSAFE, 68)),
    ),
    positive(
      "slack webhook",
      join("https://hooks.", "slack.com/services/", rand(UPPER_ALNUM, 44)),
      { gitleaksRule: "slack-webhook-url" },
    ),
    positive(
      "telegram bot token",
      join(rand("123456789", 1), rand(DIGITS, 9), ":", "AA", rand(URLSAFE, 33)),
    ),
    positive(
      "telegram bot token by keyword",
      join(rand("123456789", 1), rand(DIGITS, 9), ":", "A", rand(LOWER_ALNUM, 34)),
      { context: (s) => `telegram bot: ${s}`, gitleaksRule: "telegram-bot-api-token" },
    ),
    positive("xai", join("xai", "-", rand(ALNUM, 80))),

    // Providers we integrate with.
    positive("github classic pat", join("ghp", "_", rand(ALNUM, 36))),
    positive("github fine-grained pat", join("github", "_pat_", rand(ALNUM, 82))),
    positive("github oauth", join("gho", "_", rand(ALNUM, 36))),
    positive("gitlab pat", join("glpat", "-", rand(ALNUM, 20))),
    positive(
      "slack bot token",
      join("xoxb", "-", rand(DIGITS, 12), "-", rand(DIGITS, 12), "-", rand(ALNUM, 24)),
    ),
    positive(
      "slack app token",
      join("xapp", "-1-", rand(UPPER_ALNUM, 11), "-", rand(DIGITS, 13), "-", rand(HEX, 64)),
    ),
    positive("linear api key", join("lin", "_api_", rand(ALNUM, 40))),
    positive("anthropic api key", join("sk-ant", "-api03-", rand(URLSAFE, 93), "AA")),
    positive(
      "openai project key",
      join("sk-proj", "-", rand(URLSAFE, 58), "T3Blbk", "FJ", rand(URLSAFE, 58)),
    ),
    positive("aws access key id", join("AKIA", rand("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16))),
    positive("google api key", join("AIza", rand(URLSAFE, 35))),
    positive("npm token", join("npm", "_", rand(ALNUM, 36))),
    positive("atlassian api token", join("ATATT3", rand(URLSAFE, 186))),
    positive("notion", join("ntn", "_", rand(DIGITS, 11), rand(ALNUM, 35)), {
      gitleaksRule: "notion-api-token",
    }),
    positive("fly.io", join("fo1", "_", rand(URLSAFE, 43)), { gitleaksRule: "flyio-access-token" }),
    positive("doppler", join("dp", ".pt.", rand(ALNUM, 43)), { gitleaksRule: "doppler-api-token" }),
    positive("grafana service account", join("glsa", "_", rand(ALNUM, 32), "_", rand(HEX, 8)), {
      gitleaksRule: "grafana-service-account-token",
    }),
    positive("postman", join("PMAK", "-", rand(HEX, 24), "-", rand(HEX, 34)), {
      gitleaksRule: "postman-api-token",
    }),
    positive("shopify", join("shpat", "_", rand(HEX, 32)), {
      gitleaksRule: "shopify-access-token",
    }),
    positive("digitalocean", join("dop", "_v1_", rand(HEX, 64)), {
      gitleaksRule: "digitalocean-pat",
    }),
    positive("databricks", join("dapi", rand(HEX, 32)), { gitleaksRule: "databricks-api-token" }),
    positive("pypi", join("pypi", "-AgEIcHlwaS5vcmc", rand(URLSAFE, 70)), {
      gitleaksRule: "pypi-upload-token",
    }),
    positive("sentry user token", join("sntryu", "_", rand(HEX, 64)), {
      gitleaksRule: "sentry-user-token",
    }),
    positive("heroku", join("HRKU", "-AA", rand(URLSAFE, 58)), {
      gitleaksRule: "heroku-api-key-v2",
    }),
    positive("twilio", join("SK", rand(HEX, 32)), { gitleaksRule: "twilio-api-key" }),
    positive("mailgun", join("key", "-", rand(HEX, 32)), {
      context: (s) => `mailgun: ${s}`,
      gitleaksRule: "mailgun-private-api-token",
    }),
    positive("new relic", join("NRAK", "-", rand(UPPER_ALNUM, 27)), {
      context: (s) => `newrelic = ${s}`,
      gitleaksRule: "new-relic-user-api-key",
    }),
    positive("vault service token", join("hvs", ".", rand(ALNUM, 96)), {
      gitleaksRule: "vault-service-token",
    }),
    positive("sourcegraph", join("sgp", "_", rand(HEX, 40)), {
      gitleaksRule: "sourcegraph-access-token",
    }),
    positive("sourcegraph instance", join("sgp", "_", rand(HEX, 16), "_", rand(HEX, 40)), {
      gitleaksRule: "sourcegraph-access-token",
    }),
  ];
}

const sha1 = (seed: string) => createHash("sha1").update(seed).digest("hex");
const sha256 = (seed: string) => createHash("sha256").update(seed).digest("hex");
const uuid = (seed: string) => {
  const h = sha256(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const b64 = (seed: string, bytes: number) => {
  let buf = Buffer.alloc(0);
  for (let i = 0; buf.length < bytes; i++) {
    buf = Buffer.concat([buf, createHash("sha256").update(`${seed}:${i}`).digest()]);
  }
  return buf.subarray(0, bytes).toString("base64");
};

/** Real-looking strings an agent log carries that are not credentials. */
export function buildNegatives(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 10; i++) {
    out.push(`commit ${sha1(`commit-${i}`)}`);
    out.push(`task ${uuid(`task-${i}`)} completed`);
  }
  for (let i = 0; i < 5; i++) {
    out.push(`git checkout ${sha1(`short-${i}`).slice(0, 7)}`);
    out.push(`image sha256:${sha256(`image-${i}`)}`);
    out.push(`{"id":"${uuid(`json-${i}`)}","parentTaskId":"${uuid(`parent-${i}`)}"}`);
  }
  // Provider keywords in prose next to commit SHAs, digests and UUIDs. The
  // keyword gate only needs the word somewhere in the text, so a rule with a
  // bare hex or UUID branch would redact these.
  for (const [i, kw] of [
    "sourcegraph",
    "heroku",
    "twilio",
    "mailgun",
    "databricks",
    "sentry",
    "datadog",
    "github",
    "gitlab",
    "linear",
    "okta",
    "azure",
  ].entries()) {
    out.push(
      `${kw} searched commit ${sha1(`kw-commit-${i}`)} for references`,
      `${kw} deploy ${uuid(`kw-deploy-${i}`)} finished`,
      `${kw} run ${sha256(`kw-run-${i}`)} passed`,
      `${kw} request id ${sha256(`kw-req-${i}`).slice(0, 32)}`,
    );
  }
  out.push(
    `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA${b64("png", 600)}`,
    `data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ${b64("jpeg", 900)}`,
    `"thumbnail": "${b64("thumb", 300)}"`,
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-4-5-20251001",
    "google/gemini-3-flash-preview",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5.1-codex-mini",
    "meta-llama/llama-3.3-70b-instruct",
    "v1.4.0",
    "1.62.3-beta.2+build.4711",
    "^5.9.2",
    "bun 1.4.0 (linux-x64)",
    "https://github.com/desplega-ai/agent-swarm/pull/1918",
    "https://github.com/desplega-ai/agent-swarm/actions/runs/18234567890/job/52012345678",
    "https://docs.stripe.com/keys#obtain-api-keys",
    "https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct/resolve/main/config.json",
    "https://api.telegram.org/bot<token>/getMe",
    "https://hooks.slack.com/services/",
    "https://www.npmjs.com/package/@modelcontextprotocol/sdk?activeTab=versions",
    "http://localhost:3013/api/tasks?status=in_progress&limit=50",
    "postgres://localhost:5432/agent_swarm",
    "/workspace/personal/worktrees/agent-swarm-gitleaks-rules/src/utils/secret-scrubber.ts",
    "src/utils/secret-rules.generated.ts:120:5",
    "2026-10-07T00:36:49.123Z",
    "Wed Oct 7 02:36:49 CEST 2026",
    "NODE_ENV=production",
    "LOG_LEVEL=debug",
    "PORT=3013",
    "MCP_BASE_URL=http://localhost:3013",
    "HARNESS_PROVIDER=claude",
    "export PATH=/usr/local/bin:$PATH",
    "the monkey keyed the lock and they left",
    "okta: enabled for SSO, see the okta admin page",
    "jira: DES-1234 moved to In Review",
    "the sumo wrestler won 3 bouts",
    "telegram channel @desplega_updates has 120 members",
    "heroku: deployed my-app-123 to the eu region",
    "cohere: model command-r-plus-08-2024",
    "slack: posted to #swarm-dev-2",
    "github: desplega-ai/agent-swarm#1918",
    "const keys = Object.keys(this.state.items);",
    "s.length > 0 && s.startsWith('x')",
    "pat.name === 'default'",
    "pip install scikit-learn==1.5.2",
    "sk-learn is not a package name",
    "ask the risky task skill",
    "api-docs and api-reference live under docs-site/",
    "rk_tests_helper.ts",
    "re_validate_payload_and_retry_failed_steps",
    "ya29 is a prefix, not a token",
    "1//0 is not a refresh token",
    "xai-grok-4",
    "the api key is stored in swarm_config, not in env",
    "Authorization header omitted",
    "Bearer token rotation runs nightly",
    "password reset email sent to user@example.com",
    "token count: 128000",
    "secret scanning is enabled on the repo",
    "SKU-2024-ABCDEF-001",
    "AKIA is the prefix of an AWS access key id",
    "AIza is the prefix of a Google API key",
    "ghp_ prefix marks a classic GitHub PAT",
    "C0AR967K0KZ",
    "U0ALZGQCF96",
    "1759797409.123456",
    "*/15 * * * *",
    "192.168.1.10:8080",
    "#3b82f6",
    "rgba(59, 130, 246, 0.5)",
    "@modelcontextprotocol/sdk@1.20.1",
    "node_modules/.bin/biome check --write",
    "refs/heads/feat/scrubber-gitleaks-rules",
    "Merge pull request #1912 from desplega-ai/fix/tasks-scrub",
    "error: ENOENT: no such file or directory, open '/tmp/x.json'",
    "TypeError: Cannot read properties of undefined (reading 'id')",
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
    "WARN [heartbeat] task stalled for 300000ms, requeueing",
    "ran 1681 tests across 412 files in 93.4s",
    "SELECT id, name FROM agents WHERE status = 'idle' LIMIT 10",
    "base64: SGVsbG8sIHdvcmxkIQ==",
    "eyes on the prize",
    "they keyed in the hex 0x7f454c46",
    "s.a.r.l. is a company form",
    "hvs is not a vault token without a dot",
    "dapi is short for data api",
    "PMAK stands for Postman API key",
    "ntn_ prefix belongs to Notion",
    "fo1_ prefix belongs to Fly.io",
    "the stripe dashboard shows sk_live_ keys masked",
  );
  return out;
}
