// Sanity check for `deriveIntegrationStatus` / `findConfigForKey`.
//
// Run ad-hoc: `bun new-ui/src/lib/integrations-status.sanity.ts`
//
// Covers: none / partial / full / disabled / reserved-key-skipped / no-required-fields.
//
// This file exists because `new-ui/` has no test runner (no vitest/jest) —
// it's a temporary stand-in. If a test harness is added later, convert this
// into `integrations-status.test.ts`.

// `process` is provided by Bun/Node at runtime; we declare it locally so this
// ad-hoc script compiles without adding `@types/node` as a dev dependency.
declare const process: { exit(code: number): void };

import type { SwarmConfig } from "@/api/types";
import { INTEGRATIONS } from "./integrations-catalog";
import {
  deriveIntegrationStatus,
  findConfigForKey,
  type IntegrationStatus,
} from "./integrations-status";

function makeConfig(key: string, value: string, opts: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    id: `fake-${key}`,
    scope: "global",
    scopeId: null,
    key,
    value,
    isSecret: false,
    envPath: null,
    description: null,
    createdAt: "2026-04-21T00:00:00.000Z",
    lastUpdatedAt: "2026-04-21T00:00:00.000Z",
    encrypted: false,
    ...opts,
  };
}

function byId(id: string) {
  const def = INTEGRATIONS.find((i) => i.id === id);
  if (!def) throw new Error(`Catalog missing integration: ${id}`);
  return def;
}

interface Case {
  label: string;
  integrationId: string;
  configs: SwarmConfig[];
  expected: IntegrationStatus;
}

const slack = byId("slack");
const github = byId("github");
const businessUse = byId("business-use");

const slackRequired = slack.fields.filter((f) => f.required).map((f) => f.key);

const cases: Case[] = [
  {
    label: "slack — none (empty configs)",
    integrationId: "slack",
    configs: [],
    expected: "none",
  },
  {
    label: "slack — partial (only BOT_TOKEN set)",
    integrationId: "slack",
    configs: [makeConfig("SLACK_BOT_TOKEN", "xoxb-1", { isSecret: true })],
    expected: "partial",
  },
  {
    label: "slack — configured (all 3 required)",
    integrationId: "slack",
    configs: slackRequired.map((k) => makeConfig(k, `value-${k}`, { isSecret: true })),
    expected: "configured",
  },
  {
    label: "slack — disabled beats configured (SLACK_DISABLE=true)",
    integrationId: "slack",
    configs: [
      ...slackRequired.map((k) => makeConfig(k, `value-${k}`, { isSecret: true })),
      makeConfig("SLACK_DISABLE", "true"),
    ],
    expected: "disabled",
  },
  {
    label: "slack — DISABLE=false does NOT disable",
    integrationId: "slack",
    configs: [
      ...slackRequired.map((k) => makeConfig(k, `value-${k}`, { isSecret: true })),
      makeConfig("SLACK_DISABLE", "false"),
    ],
    expected: "configured",
  },
  {
    label: "slack — DISABLE=1 disables",
    integrationId: "slack",
    configs: [makeConfig("SLACK_DISABLE", "1")],
    expected: "disabled",
  },
  {
    label: "slack — empty value does NOT count as present",
    integrationId: "slack",
    configs: [makeConfig("SLACK_BOT_TOKEN", "")],
    expected: "none",
  },
  {
    label: "slack — reserved-key row is skipped (API_KEY row must not flip status)",
    integrationId: "slack",
    configs: [makeConfig("API_KEY", "shouldneverbehere")],
    expected: "none",
  },
  {
    label: "github — partial (only TOKEN + EMAIL set, missing WEBHOOK + NAME)",
    integrationId: "github",
    configs: [
      makeConfig("GITHUB_TOKEN", "ghp_x", { isSecret: true }),
      makeConfig("GITHUB_EMAIL", "swarm@example.com"),
    ],
    expected: "partial",
  },
  {
    label: "github — configured (all 4 required)",
    integrationId: "github",
    configs: github.fields
      .filter((f) => f.required)
      .map((f) => makeConfig(f.key, `value-${f.key}`, { isSecret: !!f.isSecret })),
    expected: "configured",
  },
  {
    label: "codex-oauth — none (no fields, no config row)",
    integrationId: "codex-oauth",
    configs: [],
    expected: "none",
  },
  {
    label: "business-use — URL-only is 'none' (only 1 required field and it's missing)",
    integrationId: "business-use",
    configs: [makeConfig("BUSINESS_USE_URL", "https://bu.example.com")],
    expected: "none",
  },
  {
    label: "business-use — configured",
    integrationId: "business-use",
    configs: businessUse.fields
      .filter((f) => f.required)
      .map((f) => makeConfig(f.key, `value-${f.key}`, { isSecret: !!f.isSecret })),
    expected: "configured",
  },
];

// --- findConfigForKey sanity checks -----------------------------------------

function findConfigChecks(): Array<{ label: string; ok: boolean }> {
  const token = makeConfig("SLACK_BOT_TOKEN", "xoxb-1", { isSecret: true });
  const empty = makeConfig("SLACK_APP_TOKEN", "");
  const reserved = makeConfig("API_KEY", "nope");
  const agentScoped = makeConfig("SLACK_BOT_TOKEN", "xoxb-agent", {
    id: "agent-row",
    scope: "agent",
    scopeId: "some-agent",
  });

  return [
    {
      label: "finds a present global key",
      ok: findConfigForKey([token], "SLACK_BOT_TOKEN")?.value === "xoxb-1",
    },
    {
      label: "returns undefined for missing key",
      ok: findConfigForKey([token], "SLACK_APP_TOKEN") === undefined,
    },
    {
      label: "treats empty value as missing",
      ok: findConfigForKey([empty], "SLACK_APP_TOKEN") === undefined,
    },
    {
      label: "skips reserved keys",
      ok: findConfigForKey([reserved], "API_KEY") === undefined,
    },
    {
      label: "ignores non-global scopes",
      ok: findConfigForKey([agentScoped], "SLACK_BOT_TOKEN") === undefined,
    },
  ];
}

// --- Runner -----------------------------------------------------------------

let pass = 0;
let fail = 0;

console.log("== deriveIntegrationStatus ==");
for (const c of cases) {
  const def = byId(c.integrationId);
  const actual = deriveIntegrationStatus(def, c.configs);
  const ok = actual === c.expected;
  const mark = ok ? "OK " : "FAIL";
  console.log(`${mark} | ${c.label} -> expected=${c.expected} got=${actual}`);
  if (ok) pass++;
  else fail++;
}

console.log("\n== findConfigForKey ==");
for (const chk of findConfigChecks()) {
  const mark = chk.ok ? "OK " : "FAIL";
  console.log(`${mark} | ${chk.label}`);
  if (chk.ok) pass++;
  else fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
