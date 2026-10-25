import type { OnboardingIntegrationMethod, OnboardingSignals } from "@/api/types";
import { KEY_RULES, type SecretRule } from "@/components/onboarding/autosave-secret-field";
import { USE_CASES, type UseCase } from "@/lib/company-profile";
import { INTEGRATIONS } from "@/lib/integrations-catalog";
import { httpUrlError } from "../../components/http-url";

/**
 * What step 6 (integrations) offers, in two groups:
 * - "Chat and code": the six integrations the API derives the step from,
 *   plus the field specs each pane edits. Labels, placeholders, and secret
 *   flags come from the Settings catalog (`lib/integrations-catalog.ts`).
 * - "Business tools": Gmail and Microsoft 365 connect inline over the OAuth
 *   presets. One "More coming" row lists the rest, which open Connections in
 *   a new tab until their presets ship. Connecting one does not complete the
 *   step.
 */

export type CoreIntegrationId = keyof OnboardingSignals["integrations"];
export type BusinessToolId = "gmail" | "microsoft" | "more";
export type SetupIntegrationId = CoreIntegrationId | BusinessToolId;

export interface SetupFieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  secret: boolean;
  multiline?: boolean;
  required?: boolean;
  /** One sentence, shown in an info tooltip next to the label. */
  hint?: string;
  /** Pre-filled when the key has no stored row. Not saved while unchanged. */
  defaultValue?: string;
  /** Secrets: when a value is complete enough to autosave. */
  secretRule?: SecretRule;
  /** Non-secrets: an error message, or null when the value can be stored. */
  validate?: (value: string) => string | null;
  /** Non-secret rows stored with this key on every save. */
  alsoStores?: ReadonlyArray<{ key: string; value: string }>;
}

interface SetupItemBase {
  name: string;
  purpose: string;
  docsUrl: string;
}

export interface CoreIntegration extends SetupItemBase {
  group: "core";
  logo: string;
  id: CoreIntegrationId;
  method: OnboardingIntegrationMethod;
  /** Keys whose presence means "saved but not connected yet". */
  chipKeys: string[];
}

export interface BusinessTool extends SetupItemBase {
  group: "business";
  id: BusinessToolId;
  /** Absent: a generic icon ("More coming"). */
  logo?: string;
  /** OAuth preset that connects it inline. Absent: set up in Connections. */
  oauthPresetId?: "google" | "microsoft";
  /** Scopes for the app created from the preset, instead of the preset defaults. */
  scopes?: string[];
}

export type SetupIntegration = CoreIntegration | BusinessTool;

function docsUrl(id: CoreIntegrationId): string {
  return (
    INTEGRATIONS.find((def) => def.id === id)?.docsUrl ??
    `https://docs.agent-swarm.dev/docs/integrations/${id}`
  );
}

const CONNECTIONS_DOCS = "https://docs.agent-swarm.dev/docs/guides/script-connections";

export const CORE_INTEGRATIONS: CoreIntegration[] = [
  {
    group: "core",
    id: "slack",
    name: "Slack",
    purpose: "Run the swarm from a channel.",
    logo: "/integration-logos/slack.svg",
    docsUrl: docsUrl("slack"),
    method: "slack",
    chipKeys: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
  },
  {
    group: "core",
    id: "github",
    name: "GitHub",
    purpose: "Issues, pull requests, and reviews.",
    logo: "/integration-logos/github.svg",
    docsUrl: docsUrl("github"),
    method: "github",
    chipKeys: ["GITHUB_TOKEN", "GITHUB_APP_ID"],
  },
  {
    group: "core",
    id: "gitlab",
    name: "GitLab",
    purpose: "Issues and merge requests.",
    logo: "/integration-logos/gitlab.svg",
    docsUrl: docsUrl("gitlab"),
    method: "gitlab",
    chipKeys: ["GITLAB_TOKEN"],
  },
  {
    group: "core",
    id: "bitbucket",
    name: "Bitbucket",
    purpose: "Bitbucket Cloud pull requests and reviews.",
    logo: "/integration-logos/bitbucket.svg",
    docsUrl: docsUrl("bitbucket"),
    method: "bitbucket",
    chipKeys: ["BITBUCKET_TOKEN", "BITBUCKET_WEBHOOK_SECRET"],
  },
  {
    group: "core",
    id: "linear",
    name: "Linear",
    purpose: "Issues and status sync over OAuth.",
    logo: "/integration-logos/linear.svg",
    docsUrl: docsUrl("linear"),
    method: "linear_oauth",
    chipKeys: ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"],
  },
  {
    group: "core",
    id: "jira",
    name: "Jira",
    purpose: "Issues and status sync over OAuth.",
    logo: "/integration-logos/jira.svg",
    docsUrl: docsUrl("jira"),
    method: "jira_oauth",
    chipKeys: ["JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET"],
  },
];

const BUSINESS_TOOLS: BusinessTool[] = [
  {
    group: "business",
    id: "gmail",
    name: "Gmail",
    purpose: "Your Google account over OAuth.",
    logo: "/integration-logos/gmail.svg",
    docsUrl: CONNECTIONS_DOCS,
    oauthPresetId: "google",
    // The Google preset covers identity only. Gmail needs its own scope.
    scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"],
  },
  {
    group: "business",
    id: "microsoft",
    name: "Microsoft 365",
    purpose: "Mail, Teams, and files over Microsoft Graph.",
    logo: "/integration-logos/microsoft.svg",
    docsUrl: CONNECTIONS_DOCS,
    oauthPresetId: "microsoft",
  },
  {
    group: "business",
    id: "more",
    name: "More coming",
    purpose: "Guided setup for these tools ships later.",
    docsUrl: CONNECTIONS_DOCS,
  },
];

/** A business tool with no guided setup yet. It connects from Connections. */
export interface ComingSoonTool {
  name: string;
  purpose: string;
  logo: string;
}

export const COMING_SOON_TOOLS: ComingSoonTool[] = [
  { name: "Figma", purpose: "Design files and comments.", logo: "/integration-logos/figma.svg" },
  {
    name: "Stripe",
    purpose: "Payments, customers, and subscriptions.",
    logo: "/integration-logos/stripe.svg",
  },
  {
    name: "Salesforce",
    purpose: "Accounts, leads, and opportunities.",
    logo: "/integration-logos/salesforce.svg",
  },
  {
    name: "Shopify",
    purpose: "Orders, products, and customers.",
    logo: "/integration-logos/shopify.svg",
  },
  {
    name: "Granola",
    purpose: "Meeting notes and transcripts.",
    logo: "/integration-logos/granola.svg",
  },
];

export type SetupGroup = { label: string; items: SetupIntegration[] };

const CHAT_AND_CODE: SetupGroup = { label: "Chat and code", items: CORE_INTEGRATIONS };
const BUSINESS: SetupGroup = { label: "Business tools", items: BUSINESS_TOOLS };

/** The step 6 groups. A "Run the business" use case lists the business tools first. */
export function setupGroups(useCase: UseCase | null): SetupGroup[] {
  const business = USE_CASES.find((option) => option.value === useCase)?.group === "business";
  return business ? [BUSINESS, CHAT_AND_CODE] : [CHAT_AND_CODE, BUSINESS];
}

export const SETUP_INTEGRATIONS: SetupIntegration[] = [...CORE_INTEGRATIONS, ...BUSINESS_TOOLS];

export function findSetupIntegration(id: string | null): SetupIntegration | undefined {
  return SETUP_INTEGRATIONS.find((item) => item.id === id);
}

/** Build a spec from the catalog entry, with local overrides. */
function spec(
  integrationId: CoreIntegrationId,
  key: string,
  overrides: Partial<SetupFieldSpec> = {},
): SetupFieldSpec {
  const field = INTEGRATIONS.find((def) => def.id === integrationId)?.fields.find(
    (f) => f.key === key,
  );
  const secret = field?.isSecret === true;
  return {
    key,
    label: field?.label ?? key,
    placeholder: field?.placeholder ?? (secret ? "••••" : undefined),
    secret,
    multiline: field?.type === "textarea",
    ...overrides,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = (value: string) => (EMAIL_RE.test(value) ? null : "Use an email address.");
const validDigits = (value: string) => (/^\d+$/.test(value) ? null : "Use the numeric App ID.");

/**
 * Socket mode only: HTTP mode is not implemented, so it is not offered here.
 * Every token save also stores `SLACK_MODE=socket`, which repairs a stale `http`.
 */
const SLACK_SOCKET_MODE = [{ key: "SLACK_MODE", value: "socket" }];

export const SLACK_TOKEN_FIELDS: SetupFieldSpec[] = [
  spec("slack", "SLACK_BOT_TOKEN", {
    required: true,
    hint: "OAuth & Permissions, Bot User OAuth Token.",
    secretRule: KEY_RULES.slackBot,
    alsoStores: SLACK_SOCKET_MODE,
  }),
  spec("slack", "SLACK_APP_TOKEN", {
    label: "App-level token",
    required: true,
    hint: "Basic Information, App-Level Tokens, with the connections:write scope.",
    secretRule: KEY_RULES.slackApp,
    alsoStores: SLACK_SOCKET_MODE,
  }),
];

export const GITHUB_FIELDS: SetupFieldSpec[] = [
  spec("github", "GITHUB_TOKEN", {
    required: true,
    secretRule: KEY_RULES.github,
  }),
  spec("github", "GITHUB_WEBHOOK_SECRET"),
  spec("github", "GITHUB_EMAIL", {
    hint: "The email and name sign every commit the agents push.",
    validate: validEmail,
  }),
  spec("github", "GITHUB_NAME"),
];

export const GITHUB_APP_FIELDS: SetupFieldSpec[] = [
  spec("github", "GITHUB_APP_ID", {
    hint: "Use an App instead of a token for per-repo installs and higher rate limits.",
    validate: validDigits,
  }),
  spec("github", "GITHUB_APP_PRIVATE_KEY", {
    secretRule: {
      pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/,
      hint: "Paste the whole PEM file, BEGIN and END lines included.",
    },
  }),
];

export const GITLAB_FIELDS: SetupFieldSpec[] = [
  spec("gitlab", "GITLAB_TOKEN", { required: true, secretRule: KEY_RULES.gitlab }),
  spec("gitlab", "GITLAB_WEBHOOK_SECRET"),
  spec("gitlab", "GITLAB_EMAIL", {
    hint: "The email and name sign every commit the agents push.",
    validate: validEmail,
  }),
  spec("gitlab", "GITLAB_NAME"),
  spec("gitlab", "GITLAB_URL", {
    defaultValue: "https://gitlab.com",
    hint: "Point this at your own host for self-managed GitLab.",
    validate: (value) => httpUrlError(value),
  }),
];

export const BITBUCKET_FIELDS: SetupFieldSpec[] = [
  spec("bitbucket", "BITBUCKET_TOKEN", { required: true, secretRule: KEY_RULES.bitbucket }),
  spec("bitbucket", "BITBUCKET_WEBHOOK_SECRET", {
    required: true,
    hint: "The same secret goes on the Bitbucket webhook. It enables the integration.",
  }),
  spec("bitbucket", "BITBUCKET_EMAIL", {
    hint: "Signs commits only when no GitHub, GitLab, or Azure DevOps token is set.",
    validate: validEmail,
  }),
  spec("bitbucket", "BITBUCKET_NAME"),
];

export const LINEAR_FIELDS: SetupFieldSpec[] = [
  spec("linear", "LINEAR_CLIENT_ID", { required: true }),
  spec("linear", "LINEAR_CLIENT_SECRET", { required: true }),
  spec("linear", "LINEAR_SIGNING_SECRET", { hint: "Verifies Linear webhook payloads." }),
];

export const JIRA_FIELDS: SetupFieldSpec[] = [
  spec("jira", "JIRA_CLIENT_ID", { required: true }),
  spec("jira", "JIRA_CLIENT_SECRET", { required: true }),
  spec("jira", "JIRA_WEBHOOK_TOKEN", { hint: "Shared token on the Jira webhook URL." }),
];

const requiredKeys = (specs: SetupFieldSpec[]) => specs.filter((f) => f.required).map((f) => f.key);

/** Keys an integration needs before it can connect ("1 of 2" until all are saved). */
export const REQUIRED_KEYS: Record<CoreIntegrationId, string[]> = {
  slack: requiredKeys(SLACK_TOKEN_FIELDS),
  github: requiredKeys(GITHUB_FIELDS),
  gitlab: requiredKeys(GITLAB_FIELDS),
  bitbucket: requiredKeys(BITBUCKET_FIELDS),
  linear: requiredKeys(LINEAR_FIELDS),
  jira: requiredKeys(JIRA_FIELDS),
};

/** Every key the step reads presence for, in one `env-presence` query. */
export const ALL_SETUP_KEYS: string[] = [
  ...SLACK_TOKEN_FIELDS,
  ...GITHUB_FIELDS,
  ...GITHUB_APP_FIELDS,
  ...GITLAB_FIELDS,
  ...BITBUCKET_FIELDS,
  ...LINEAR_FIELDS,
  ...JIRA_FIELDS,
].map((f) => f.key);

/** First connected integration, in the order the API uses to infer the method. */
export function connectedMethod(
  integrations: OnboardingSignals["integrations"],
): OnboardingIntegrationMethod | null {
  return CORE_INTEGRATIONS.find((item) => integrations[item.id])?.method ?? null;
}
