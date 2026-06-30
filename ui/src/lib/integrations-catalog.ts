// Integrations catalog — single source of truth for the Integrations UI.
//
// Each `IntegrationDef` describes a third-party integration: its human-facing
// metadata, the `swarm_config` global rows it maps to, and any special flow
// (Linear OAuth, Codex CLI) that needs custom UI.
//
// Reserved keys (`API_KEY`, `SECRETS_ENCRYPTION_KEY`) are intentionally NOT
// listed here — they're rejected server-side by `swarm-config-guard.ts` and
// must never be stored in `swarm_config`.
//
// See plan: thoughts/taras/plans/2026-04-21-integrations-ui.md (Phase 1).

export type IntegrationFieldType = "text" | "password" | "textarea" | "select" | "boolean";

export interface IntegrationField {
  /** swarm_config key (e.g. "SLACK_BOT_TOKEN"). */
  key: string;
  label: string;
  type: IntegrationFieldType;
  required?: boolean;
  isSecret?: boolean;
  placeholder?: string;
  helpText?: string;
  /** Options for `type: "select"`. */
  options?: { value: string; label: string }[];
  /** Collapsed under "Advanced" by default. */
  advanced?: boolean;
  default?: string;
  /** Comma-separated list hint (credential pool). */
  credentialPool?: boolean;
  /** Shows restart hint when true. */
  affectsRestart?: boolean;
}

export interface IntegrationConfigGroup {
  id: string;
  title: string;
  description?: string;
  docsUrl?: string;
  fields: IntegrationField[];
}

export type IntegrationCategory =
  | "comm"
  | "issues"
  | "crm"
  | "llm"
  | "observability"
  | "payments"
  | "email"
  | "other";

export type IntegrationSpecialFlow =
  | "linear-oauth"
  | "jira-oauth"
  | "codex-cli"
  | "claude-managed-cli";

/** Which agent role(s) the swarm needs to have a given skill installed on. */
export type AgentRole = "lead" | "worker";

/**
 * Where a recommended skill lives.
 *
 * - `'swarm-registry'`: already published in the swarm skills registry
 *   (installable from /settings/skills, resolvable by name in the `skills` DB table).
 * - `'template'`: checked in under `templates/skills/<name>/SKILL.md` in the
 *   agent-swarm repo. Installable via `skill-install-remote` using the
 *   `templateRepo` + `templatePath` fields on the entry.
 */
export type SkillSource = "swarm-registry" | "template";

export interface RecommendedSkill {
  /** Canonical name — matches the `name` column in the swarm skills registry. */
  name: string;
  /** Where this skill lives (see {@link SkillSource}). */
  source: SkillSource;
  /** Agent roles that need the skill installed for this integration to work end-to-end. */
  roles: AgentRole[];
  /** One-liner shown beside the skill explaining why it's needed. */
  reason?: string;
  /**
   * GitHub repo slug (`owner/repo`) hosting the SKILL.md.
   * Only set when `source === 'template'`.
   * Passed directly to `skill-install-remote` as `sourceRepo`.
   */
  templateRepo?: string;
  /**
   * Path inside `templateRepo` that contains `SKILL.md`.
   * Only set when `source === 'template'`.
   * Passed directly to `skill-install-remote` as `sourcePath`.
   */
  templatePath?: string;
  /**
   * When true, the skill is automatically installed (via `skill-install-remote`)
   * as part of integration setup — the operator doesn't need to visit
   * /settings/skills to install it manually.
   * Only meaningful when `source === 'template'` and `templateRepo` is set.
   */
  installOnSetup?: boolean;
}

export interface IntegrationDef {
  /** URL slug (kebab-case). Must be unique. */
  id: string;
  name: string;
  description: string;
  category: IntegrationCategory;
  /** Maps to a lucide-react icon name at render time. */
  iconKey: string;
  /** Optional brand/logo asset path. Falls back to iconKey when unset. */
  logoSrc?: string;
  /** External docs URL or in-repo docs path. */
  docsUrl: string;
  fields: IntegrationField[];
  /** Optional grouped field layout for integrations with multiple harness modes. */
  configGroups?: IntegrationConfigGroup[];
  /** Env var that disables the integration (e.g. "SLACK_DISABLE"). */
  disableKey?: string;
  /** Changes require API server restart to take effect. */
  restartRequired?: boolean;
  /** Custom flow that overrides the generic field form. */
  specialFlow?: IntegrationSpecialFlow;
  /**
   * Skills recommended alongside this integration. Env-var configuration is
   * not always enough — some integrations depend on procedural knowledge (a
   * skill) installed on a specific agent role. Each entry declares where the
   * skill lives so the operator knows how to get it.
   */
  recommendedSkills?: RecommendedSkill[];
}

export function getIntegrationFields(def: IntegrationDef): IntegrationField[] {
  const groups = def.configGroups ?? [];
  if (groups.length === 0) return def.fields;

  const seen = new Set<string>();
  const fields: IntegrationField[] = [];
  for (const field of groups.flatMap((group) => group.fields)) {
    if (seen.has(field.key)) continue;
    seen.add(field.key);
    fields.push(field);
  }
  return fields;
}

export const INTEGRATIONS: IntegrationDef[] = [
  // ---------------------------------------------------------------- Slack
  {
    id: "slack",
    name: "Slack",
    description: "Chat with the swarm from Slack — assign tasks, get alerts, follow-up in threads.",
    category: "comm",
    iconKey: "message-square",
    docsUrl: "https://docs.agent-swarm.dev/integrations/slack",
    disableKey: "SLACK_DISABLE",
    restartRequired: true,
    fields: [
      {
        key: "SLACK_BOT_TOKEN",
        label: "Bot token",
        type: "password",
        required: true,
        isSecret: true,
        placeholder: "xoxb-...",
        helpText: "OAuth bot token from your Slack app's OAuth & Permissions page.",
        affectsRestart: true,
      },
      {
        key: "SLACK_APP_TOKEN",
        label: "App-level token",
        type: "password",
        required: true,
        isSecret: true,
        placeholder: "xapp-...",
        helpText: "App-level token with `connections:write` scope, used for Socket Mode.",
        affectsRestart: true,
      },
      {
        key: "SLACK_SIGNING_SECRET",
        label: "Signing secret",
        type: "password",
        isSecret: true,
        helpText:
          "Only required for HTTP events. Socket Mode (the default) doesn't use it. Found under Basic Information → App Credentials.",
        affectsRestart: true,
      },
      {
        key: "SLACK_ALERTS_CHANNEL",
        label: "Alerts channel",
        type: "text",
        placeholder: "#swarm-alerts or C0123456789",
        helpText: "Channel to post system-level alerts to. Accepts either `#name` or a channel ID.",
      },
      {
        key: "SLACK_ALLOWED_EMAIL_DOMAINS",
        label: "Allowed email domains",
        type: "text",
        advanced: true,
        placeholder: "example.com,other.com",
        helpText: "Comma-separated list of email domains permitted to interact with the bot.",
      },
      {
        key: "SLACK_ALLOWED_USER_IDS",
        label: "Allowed user IDs",
        type: "text",
        advanced: true,
        placeholder: "U0123,U0456",
        helpText: "Comma-separated Slack user IDs allowed to interact.",
      },
      {
        key: "SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION",
        label: "Require mention for thread follow-ups",
        type: "boolean",
        advanced: true,
        helpText: "When true, the bot only responds to in-thread follow-ups that @mention it.",
      },
      {
        key: "ADDITIVE_SLACK",
        label: "Additive Slack mode",
        type: "boolean",
        advanced: true,
        helpText: "Combine multiple Slack messages within a short window into a single task input.",
      },
      {
        key: "ADDITIVE_SLACK_BUFFER_MS",
        label: "Additive buffer (ms)",
        type: "text",
        advanced: true,
        placeholder: "5000",
        helpText: "How long to wait before flushing an additive Slack buffer (milliseconds).",
      },
    ],
  },

  // -------------------------------------------------------- Kapso (WhatsApp)
  {
    id: "kapso",
    name: "Kapso (WhatsApp)",
    description:
      "Chat with the swarm over WhatsApp via Kapso — inbound messages become tasks, agents reply in-thread.",
    category: "comm",
    iconKey: "message-circle",
    docsUrl: "https://docs.agent-swarm.dev/integrations/kapso",
    recommendedSkills: [
      {
        name: "kapso-whatsapp",
        source: "template",
        templateRepo: "desplega-ai/agent-swarm",
        templatePath: "templates/skills/kapso-whatsapp",
        roles: ["lead", "worker"],
        reason:
          "Canonical recipes for WhatsApp beyond plain text send/reply (templates, media, reactions, typing, signature verify, contact resolution). The MCP tools only cover the common text path.",
        installOnSetup: true,
      },
    ],
    fields: [
      {
        key: "KAPSO_API_KEY",
        label: "API key",
        type: "password",
        required: true,
        isSecret: true,
        helpText:
          "Kapso API key used to send WhatsApp messages (read by the kapso-whatsapp skill). Find it in your Kapso dashboard.",
      },
      {
        key: "KAPSO_PHONE_NUMBER_ID",
        label: "Phone number ID",
        type: "text",
        required: true,
        placeholder: "123456789012345",
        helpText: "WhatsApp Business phone number ID the swarm sends from (from Kapso).",
      },
      {
        key: "KAPSO_WEBHOOK_HMAC_SECRET",
        label: "Webhook HMAC secret",
        type: "password",
        isSecret: true,
        helpText:
          "Shared secret Kapso signs inbound webhooks with (sent as the `X-Webhook-Signature` header, raw hex). Reference it from your inbound workflow's webhook trigger to verify deliveries.",
      },
      {
        key: "KAPSO_API_BASE_URL",
        label: "API base URL",
        type: "text",
        advanced: true,
        placeholder: "https://api.kapso.ai",
        helpText: "Override the Kapso API base URL. Leave blank to use https://api.kapso.ai.",
      },
    ],
  },

  // --------------------------------------------------------------- GitHub
  {
    id: "github",
    name: "GitHub",
    description:
      "React to issues/PRs, run CI, open PRs from agents. Defaults to PAT mode; App mode available under Advanced.",
    category: "issues",
    iconKey: "github",
    docsUrl: "https://docs.agent-swarm.dev/integrations/github",
    disableKey: "GITHUB_DISABLE",
    restartRequired: true,
    fields: [
      {
        key: "GITHUB_TOKEN",
        label: "Personal access token",
        type: "password",
        required: true,
        isSecret: true,
        placeholder: "ghp_... or github_pat_...",
        helpText: "Used by workers to clone repos and push commits. Scopes: `repo`, `workflow`.",
        affectsRestart: true,
      },
      {
        key: "GITHUB_WEBHOOK_SECRET",
        label: "Webhook secret",
        type: "password",
        required: true,
        isSecret: true,
        helpText: "Secret configured on your GitHub webhook — verifies incoming payloads.",
        affectsRestart: true,
      },
      {
        key: "GITHUB_EMAIL",
        label: "Commit author email",
        type: "text",
        required: true,
        placeholder: "swarm@example.com",
        helpText: "Used as `user.email` when the swarm commits code.",
      },
      {
        key: "GITHUB_NAME",
        label: "Commit author name",
        type: "text",
        required: true,
        placeholder: "Agent Swarm",
        helpText: "Used as `user.name` when the swarm commits code.",
      },
      {
        key: "GITHUB_APP_ID",
        label: "GitHub App ID",
        type: "text",
        advanced: true,
        helpText:
          "For App-mode authentication (recommended in production). Found in the App settings URL.",
        affectsRestart: true,
      },
      {
        key: "GITHUB_APP_PRIVATE_KEY",
        label: "GitHub App private key",
        type: "textarea",
        advanced: true,
        isSecret: true,
        placeholder: "-----BEGIN RSA PRIVATE KEY-----\n...",
        helpText:
          "PEM-encoded private key for the GitHub App. Paste including the BEGIN/END lines.",
        affectsRestart: true,
      },
      {
        key: "GITHUB_BOT_NAME",
        label: "Bot name",
        type: "text",
        advanced: true,
        helpText: "Display name the bot appears as in GitHub (App-mode bot login).",
      },
      {
        key: "GITHUB_BOT_ALIASES",
        label: "Bot aliases",
        type: "text",
        advanced: true,
        placeholder: "swarm,agent",
        helpText: "Comma-separated aliases the bot also responds to in issue/PR mentions.",
      },
      {
        key: "GITHUB_EVENT_LABELS",
        label: "Event labels",
        type: "text",
        advanced: true,
        placeholder: "agent-swarm,auto",
        helpText: "Comma-separated labels that trigger swarm handling on issues/PRs.",
      },
    ],
  },

  // --------------------------------------------------------------- GitLab
  {
    id: "gitlab",
    name: "GitLab",
    description:
      "React to GitLab issues/MRs and push commits from agents. Supports self-hosted instances.",
    category: "issues",
    iconKey: "git-merge",
    docsUrl: "https://docs.agent-swarm.dev/integrations/gitlab",
    disableKey: "GITLAB_DISABLE",
    restartRequired: true,
    fields: [
      {
        key: "GITLAB_TOKEN",
        label: "Personal access token",
        type: "password",
        required: true,
        isSecret: true,
        placeholder: "glpat-...",
        helpText:
          "Used by workers to clone repos and push commits. Scopes: `api`, `write_repository`.",
        affectsRestart: true,
      },
      {
        key: "GITLAB_WEBHOOK_SECRET",
        label: "Webhook secret",
        type: "password",
        required: true,
        isSecret: true,
        helpText: "Secret configured on your GitLab webhook — verifies incoming payloads.",
        affectsRestart: true,
      },
      {
        key: "GITLAB_EMAIL",
        label: "Commit author email",
        type: "text",
        required: true,
        placeholder: "swarm@example.com",
        helpText: "Used as `user.email` when the swarm commits code.",
      },
      {
        key: "GITLAB_NAME",
        label: "Commit author name",
        type: "text",
        required: true,
        placeholder: "Agent Swarm",
        helpText: "Used as `user.name` when the swarm commits code.",
      },
      {
        key: "GITLAB_URL",
        label: "GitLab URL",
        type: "text",
        placeholder: "https://gitlab.com",
        helpText: "Override for self-hosted GitLab. Defaults to `https://gitlab.com`.",
      },
      {
        key: "GITLAB_BOT_NAME",
        label: "Bot name",
        type: "text",
        advanced: true,
        helpText: "Display name the bot appears as in GitLab comments.",
      },
    ],
  },

  // --------------------------------------------------------------- Linear
  {
    id: "linear",
    name: "Linear",
    description:
      "Sync Linear issues to tasks, comment from agents, respond to mentions. Uses OAuth.",
    category: "issues",
    iconKey: "square-check-big",
    docsUrl: "https://docs.agent-swarm.dev/integrations/linear",
    disableKey: "LINEAR_DISABLE",
    restartRequired: true,
    specialFlow: "linear-oauth",
    fields: [
      {
        key: "LINEAR_CLIENT_ID",
        label: "OAuth client ID",
        type: "text",
        required: true,
        helpText: "From your Linear OAuth application (Settings → API → OAuth applications).",
        affectsRestart: true,
      },
      {
        key: "LINEAR_CLIENT_SECRET",
        label: "OAuth client secret",
        type: "password",
        required: true,
        isSecret: true,
        helpText: "OAuth client secret paired with the client ID above.",
        affectsRestart: true,
      },
      {
        key: "LINEAR_SIGNING_SECRET",
        label: "Webhook signing secret",
        type: "password",
        required: true,
        isSecret: true,
        helpText: "Secret used to verify Linear webhook signatures.",
        affectsRestart: true,
      },
    ],
  },

  // ------------------------------------------------------------------ Jira
  {
    id: "jira",
    name: "Jira",
    description:
      "Sync Jira Cloud issues to tasks via OAuth 3LO. Inbound on assignee→bot or @-mention; outbound lifecycle comments back to the issue.",
    category: "issues",
    iconKey: "square-check-big",
    docsUrl: "https://docs.agent-swarm.dev/guides/jira-integration",
    disableKey: "JIRA_DISABLE",
    restartRequired: true,
    specialFlow: "jira-oauth",
    fields: [
      {
        key: "JIRA_CLIENT_ID",
        label: "OAuth client ID",
        type: "text",
        required: true,
        helpText:
          "From your Atlassian OAuth 2.0 (3LO) app (developer.atlassian.com → My Apps → Settings).",
        affectsRestart: true,
      },
      {
        key: "JIRA_CLIENT_SECRET",
        label: "OAuth client secret",
        type: "password",
        required: true,
        isSecret: true,
        helpText: "OAuth client secret paired with the client ID above.",
        affectsRestart: true,
      },
      {
        key: "JIRA_WEBHOOK_TOKEN",
        label: "Webhook URL token",
        type: "password",
        required: true,
        isSecret: true,
        helpText:
          "High-entropy token embedded in the registered webhook URL (Atlassian doesn't HMAC-sign 3LO webhooks). Generate with `openssl rand -hex 32`.",
        affectsRestart: true,
      },
      {
        key: "JIRA_REDIRECT_URI",
        label: "Custom redirect URI",
        type: "text",
        advanced: true,
        placeholder: "https://api.example.com/api/trackers/jira/callback",
        helpText:
          "Optional. Override the OAuth callback URL Atlassian redirects to after authorization. Leave blank to derive it from MCP_BASE_URL. Must match exactly what's registered in your Atlassian app.",
        affectsRestart: true,
      },
    ],
  },

  // ---------------------------------------------------------------- Attio
  {
    id: "attio",
    name: "Attio",
    description:
      "Connect agents to Attio CRM records, notes, tasks, lists, and pipeline workflows.",
    category: "crm",
    iconKey: "square-check-big",
    logoSrc: "/provider-logos/attio.svg",
    docsUrl: "https://docs.attio.com/docs/overview",
    restartRequired: true,
    recommendedSkills: [
      {
        name: "attio-interaction",
        source: "template",
        templateRepo: "desplega-ai/agent-swarm",
        templatePath: "templates/skills/attio-interaction",
        roles: ["lead", "worker"],
        reason:
          "Canonical recipes for Attio REST API v2 reads/writes, including record query, safe upsert, notes, tasks, lists, webhooks, and rate limits.",
        installOnSetup: true,
      },
    ],
    fields: [
      {
        key: "ATTIO_API_KEY",
        label: "API key",
        type: "password",
        required: true,
        isSecret: true,
        helpText:
          "Attio workspace access token used as the bearer token for Attio API calls. Generate one in Workspace settings -> Developers.",
        affectsRestart: true,
      },
    ],
  },

  // --------------------------------------------------------------- Sentry
  {
    id: "sentry",
    name: "Sentry",
    description: "Give agents access to Sentry issues and project info via the Sentry CLI.",
    category: "observability",
    iconKey: "activity",
    docsUrl: "https://docs.agent-swarm.dev/integrations/sentry",
    fields: [
      {
        key: "SENTRY_AUTH_TOKEN",
        label: "Auth token",
        type: "password",
        required: true,
        isSecret: true,
        helpText:
          "Sentry auth token with `project:read`, `event:read`. Used by the Sentry CLI inside workers.",
      },
      {
        key: "SENTRY_ORG",
        label: "Organization slug",
        type: "text",
        required: true,
        placeholder: "my-org",
        helpText: "Your Sentry organization slug (from the Sentry URL).",
      },
    ],
  },

  // ------------------------------------------------------------ AgentMail
  {
    id: "agentmail",
    name: "AgentMail",
    description: "Receive email and reply from agents. Useful for customer-support-like flows.",
    category: "email",
    iconKey: "mail",
    docsUrl: "https://docs.agent-swarm.dev/integrations/agentmail",
    disableKey: "AGENTMAIL_DISABLE",
    restartRequired: true,
    recommendedSkills: [
      {
        name: "agentmail-sending",
        source: "template",
        templateRepo: "desplega-ai/agent-swarm",
        templatePath: "templates/skills/agentmail-sending",
        roles: ["lead"],
        reason:
          "Needed for agents to send/reply to email via AgentMail (the env keys alone only enable receive).",
        installOnSetup: true,
      },
    ],
    fields: [
      {
        key: "AGENTMAIL_API_KEY",
        label: "API key",
        type: "password",
        required: true,
        isSecret: true,
        helpText:
          "AgentMail API key for sending replies. Find it at https://agentmail.to under Inboxes → API keys (`am_us_inbox_…`).",
        affectsRestart: true,
      },
      {
        key: "AGENTMAIL_WEBHOOK_SECRET",
        label: "Webhook secret",
        type: "password",
        required: true,
        isSecret: true,
        helpText: "Secret used to verify incoming AgentMail webhook deliveries.",
        affectsRestart: true,
      },
      {
        key: "AGENTMAIL_INBOX_DOMAIN_FILTER",
        label: "Inbox domain filter",
        type: "text",
        advanced: true,
        placeholder: "support.example.com",
        helpText: "Only process mail addressed to these inbox domains.",
      },
      {
        key: "AGENTMAIL_SENDER_DOMAIN_FILTER",
        label: "Sender domain filter",
        type: "text",
        advanced: true,
        placeholder: "example.com",
        helpText: "Only accept mail from senders in these domains (allow-list).",
      },
    ],
  },

  // --------------------------------------------------------------- Composio
  {
    id: "composio",
    name: "Composio",
    description:
      "Route agents to connected user accounts in Composio through the `x composio` CLI and `swarm_x` MCP tool.",
    category: "other",
    iconKey: "route",
    docsUrl: "https://docs.agent-swarm.dev/integrations/composio",
    restartRequired: true,
    recommendedSkills: [
      {
        name: "composio",
        source: "template",
        templateRepo: "desplega-ai/agent-swarm",
        templatePath: "plugin/skills/composio",
        roles: ["lead", "worker"],
        reason:
          "Operational recipes for creating Tool Router sessions, checking connected accounts, and executing Composio actions through `agent-swarm x composio` or `swarm_x`.",
      },
    ],
    fields: [
      {
        key: "COMPOSIO_API_KEY",
        label: "Project API key",
        type: "password",
        required: true,
        isSecret: true,
        helpText:
          "Composio project API key injected into `agent-swarm x composio ...` and the `swarm_x` MCP tool. Use this for normal Tool Router requests.",
        affectsRestart: true,
      },
      {
        key: "COMPOSIO_ORG_API_KEY",
        label: "Organization API key",
        type: "password",
        isSecret: true,
        helpText:
          "Optional organization-level key for requests that need org scope. The CLI uses it only with `--org`; `swarm_x` uses it when `useOrgKey` is true.",
        affectsRestart: true,
      },
      {
        key: "COMPOSIO_BASE_URL",
        label: "Base URL",
        type: "text",
        advanced: true,
        placeholder: "https://backend.composio.dev/api/v3",
        helpText:
          "Override the Composio API base URL for staging or self-hosted gateways. Leave blank for the default v3 API.",
        affectsRestart: true,
      },
    ],
  },

  // -------------------------------------------------------------- Anthropic
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude API access for workers. Supports API key or OAuth (Claude Code).",
    category: "llm",
    iconKey: "brain",
    docsUrl: "https://docs.agent-swarm.dev/integrations/anthropic",
    restartRequired: true,
    fields: [
      {
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        label: "Claude Code OAuth token",
        type: "password",
        isSecret: true,
        placeholder: "sk-ant-oat01-...",
        helpText:
          "Run `claude setup-token` (Claude Code CLI) to generate. Takes precedence over ANTHROPIC_API_KEY when both are set. Comma-separate multiple tokens to form a credential pool.",
        credentialPool: true,
        affectsRestart: true,
      },
      {
        key: "ANTHROPIC_API_KEY",
        label: "API key",
        type: "password",
        isSecret: true,
        placeholder: "sk-ant-...",
        helpText:
          "Anthropic API key. Used when no Claude Code OAuth token is set. Comma-separate multiple keys to form a credential pool.",
        credentialPool: true,
        affectsRestart: true,
      },
    ],
  },

  // ------------------------------------------------------------ OpenRouter
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Route model calls through OpenRouter (Claude, Gemini, GPT, Mistral, etc.).",
    category: "llm",
    iconKey: "route",
    docsUrl: "https://docs.agent-swarm.dev/integrations/openrouter",
    restartRequired: true,
    fields: [
      {
        key: "OPENROUTER_API_KEY",
        label: "API key",
        type: "password",
        required: true,
        isSecret: true,
        placeholder: "sk-or-...",
        helpText: "OpenRouter API key. Comma-separate multiple keys to form a credential pool.",
        credentialPool: true,
        affectsRestart: true,
      },
    ],
  },

  // ---------------------------------------------------------------- OpenAI
  {
    id: "openai",
    name: "OpenAI",
    description: "OpenAI API access for Codex workers and other OpenAI-backed harnesses.",
    category: "llm",
    iconKey: "sparkles",
    docsUrl: "https://docs.agent-swarm.dev/integrations/openai",
    restartRequired: true,
    fields: [
      {
        key: "OPENAI_API_KEY",
        label: "API key",
        type: "password",
        required: true,
        isSecret: true,
        placeholder: "sk-...",
        helpText: "OpenAI API key. Used by the codex provider when no ChatGPT OAuth is stored.",
        affectsRestart: true,
      },
    ],
  },

  // ---------------------------------------------------------- Amazon Bedrock
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    description:
      "Route pi/pi-mono and Claude Code harness calls to Amazon Bedrock with auth delegated to the AWS SDK credential chain.",
    category: "llm",
    iconKey: "cloud",
    docsUrl:
      "https://docs.agent-swarm.dev/docs/guides/harness-providers#pi-mono--amazon-bedrock-auth",
    restartRequired: true,
    fields: [],
    configGroups: [
      {
        id: "pi-mono",
        title: "pi / pi-mono",
        description:
          "Use pi-mono's Bedrock routing prefix while AWS credentials resolve through the SDK default chain.",
        docsUrl:
          "https://docs.agent-swarm.dev/docs/guides/harness-providers#pi-mono--amazon-bedrock-auth",
        fields: [
          {
            key: "MODEL_OVERRIDE",
            label: "Model override",
            type: "text",
            required: true,
            placeholder: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
            helpText:
              "Use the amazon-bedrock/<model-id> prefix to route pi/pi-mono through Amazon Bedrock.",
            affectsRestart: true,
          },
          {
            key: "AWS_REGION",
            label: "AWS region",
            type: "text",
            required: true,
            placeholder: "us-east-1",
            helpText:
              "Must be a Bedrock-enabled AWS region. AWS_DEFAULT_REGION also works for the SDK.",
            affectsRestart: true,
          },
          {
            key: "AWS_ACCESS_KEY_ID",
            label: "AWS access key ID",
            type: "password",
            isSecret: true,
            helpText:
              "Optional static credentials path. Pair with AWS_SECRET_ACCESS_KEY for the simplest Bedrock setup.",
            affectsRestart: true,
          },
          {
            key: "AWS_SECRET_ACCESS_KEY",
            label: "AWS secret access key",
            type: "password",
            isSecret: true,
            helpText:
              "Optional static credentials path. Profiles, AWS SSO, web-identity, credential_process, and assume-role chains also work.",
            affectsRestart: true,
          },
          {
            key: "AWS_SESSION_TOKEN",
            label: "AWS session token",
            type: "password",
            isSecret: true,
            placeholder: "Optional for temporary credentials",
            helpText:
              "Optional for temporary static credentials. See the harness-providers guide for all AWS SDK default credential chain sources.",
            affectsRestart: true,
          },
        ],
      },
      {
        id: "claude-code",
        title: "Claude Code",
        description:
          "Enable Claude Code's native Amazon Bedrock provider and optionally pin Bedrock inference profile IDs.",
        docsUrl: "https://code.claude.com/docs/en/amazon-bedrock",
        fields: [
          {
            key: "CLAUDE_CODE_USE_BEDROCK",
            label: "Enable Bedrock",
            type: "text",
            required: true,
            placeholder: "1",
            helpText: "Set to 1 or true to route Claude Code through Amazon Bedrock.",
            affectsRestart: true,
          },
          {
            key: "AWS_REGION",
            label: "AWS region",
            type: "text",
            required: true,
            placeholder: "us-east-1",
            helpText:
              "Required by Claude Code; it does not read AWS_REGION from ~/.aws/config. Use a region where your selected Bedrock models or inference profiles are available.",
            affectsRestart: true,
          },
          {
            key: "ANTHROPIC_MODEL",
            label: "Primary model override",
            type: "text",
            placeholder: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
            helpText:
              "Optional Bedrock inference profile ID or application inference profile ARN for the primary Claude Code model. Cross-region profile IDs commonly use a prefix such as us.",
            affectsRestart: true,
          },
          {
            key: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            label: "Small/fast model",
            type: "text",
            placeholder: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
            helpText:
              "Optional Haiku-class model for background tasks such as session title generation. Claude Code defaults this to the primary model on Bedrock when Haiku is not enabled.",
            affectsRestart: true,
          },
          {
            key: "ANTHROPIC_SMALL_FAST_MODEL",
            label: "Small/fast model (deprecated)",
            type: "text",
            advanced: true,
            placeholder: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
            helpText:
              "Deprecated Claude Code small/fast model override. Prefer ANTHROPIC_DEFAULT_HAIKU_MODEL for new Bedrock setups.",
            affectsRestart: true,
          },
          {
            key: "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
            label: "Small/fast model region",
            type: "text",
            placeholder: "us-west-2",
            helpText:
              "Optional region override for the small/fast model. On Bedrock this only matters when ANTHROPIC_DEFAULT_HAIKU_MODEL, or the deprecated ANTHROPIC_SMALL_FAST_MODEL, is set.",
            affectsRestart: true,
          },
          {
            key: "AWS_PROFILE",
            label: "AWS profile",
            type: "text",
            placeholder: "myprofile",
            helpText:
              "Optional AWS SDK profile after running aws sso login or configuring ~/.aws credentials.",
            affectsRestart: true,
          },
          {
            key: "AWS_ACCESS_KEY_ID",
            label: "AWS access key ID",
            type: "password",
            isSecret: true,
            helpText:
              "Optional static credentials path. Claude Code also supports AWS profiles, SSO, existing environment credentials, and Bedrock API keys.",
            affectsRestart: true,
          },
          {
            key: "AWS_SECRET_ACCESS_KEY",
            label: "AWS secret access key",
            type: "password",
            isSecret: true,
            helpText: "Optional static credentials path. Pair with AWS_ACCESS_KEY_ID.",
            affectsRestart: true,
          },
          {
            key: "AWS_SESSION_TOKEN",
            label: "AWS session token",
            type: "password",
            isSecret: true,
            placeholder: "Optional for temporary credentials",
            helpText: "Optional for temporary static credentials.",
            affectsRestart: true,
          },
          {
            key: "AWS_BEARER_TOKEN_BEDROCK",
            label: "Bedrock API key",
            type: "password",
            isSecret: true,
            helpText:
              "Optional Bedrock API key alternative when you do not want full AWS credentials.",
            affectsRestart: true,
          },
          {
            key: "ANTHROPIC_BEDROCK_BASE_URL",
            label: "Bedrock base URL",
            type: "text",
            advanced: true,
            placeholder: "https://bedrock-runtime.us-east-1.amazonaws.com",
            helpText: "Optional endpoint override for custom endpoints or gateways.",
            affectsRestart: true,
          },
          {
            key: "DISABLE_PROMPT_CACHING",
            label: "Disable prompt caching",
            type: "text",
            advanced: true,
            placeholder: "1",
            helpText:
              "Optional escape hatch. Prompt caching may not be available in every Bedrock model or region.",
            affectsRestart: true,
          },
          {
            key: "ENABLE_PROMPT_CACHING_1H",
            label: "Use 1-hour prompt cache",
            type: "text",
            advanced: true,
            placeholder: "1",
            helpText:
              "Optional. Requests a 1-hour prompt cache TTL instead of the 5-minute default; Claude Code docs note the longer TTL is billed at a higher rate.",
            affectsRestart: true,
          },
        ],
      },
    ],
  },

  // ---------------------------------------------------------- Codex OAuth
  {
    id: "codex-oauth",
    name: "Codex (ChatGPT OAuth)",
    description:
      "Authenticate codex workers with your ChatGPT account. Requires a CLI step — cannot be configured from the UI.",
    category: "llm",
    iconKey: "key-round",
    docsUrl: "https://docs.agent-swarm.dev/integrations/codex-oauth",
    specialFlow: "codex-cli",
    restartRequired: true,
    fields: [],
  },

  // -------------------------------------------------- Claude Managed Agents
  {
    id: "claude-managed",
    name: "Claude Managed Agents",
    description:
      "Run swarm tasks in Anthropic's managed cloud sandbox. Requires running the claude-managed-setup CLI once to create the Anthropic-side agent + environment.",
    category: "llm",
    iconKey: "cloud",
    docsUrl: "https://docs.agent-swarm.dev/guides/harness-configuration#claude-managed-agents",
    specialFlow: "claude-managed-cli",
    restartRequired: true,
    fields: [
      {
        key: "ANTHROPIC_API_KEY",
        label: "Anthropic API key",
        type: "password",
        required: true,
        isSecret: true,
        placeholder: "sk-ant-...",
        helpText: "Used by claude-managed sessions. Stored encrypted at rest in swarm_config.",
        affectsRestart: true,
      },
      {
        key: "MANAGED_AGENT_ID",
        label: "Managed agent ID",
        type: "text",
        required: true,
        placeholder: "agent_...",
        helpText: "From `bunx @desplega.ai/agent-swarm claude-managed-setup`.",
        affectsRestart: true,
      },
      {
        key: "MANAGED_ENVIRONMENT_ID",
        label: "Managed environment ID",
        type: "text",
        required: true,
        placeholder: "env_...",
        helpText: "From `bunx @desplega.ai/agent-swarm claude-managed-setup`.",
        affectsRestart: true,
      },
      {
        key: "MCP_BASE_URL",
        label: "MCP base URL",
        type: "text",
        required: true,
        placeholder: "https://api.swarm.example.com",
        helpText:
          "Must be HTTPS-public so Anthropic's sandbox can reach `/mcp`. Reuses the same env var as Jira webhook setup.",
        affectsRestart: true,
      },
      {
        key: "MANAGED_AGENT_MODEL",
        label: "Default model",
        type: "text",
        placeholder: "claude-sonnet-5",
        helpText: "Optional override. Defaults to claude-sonnet-5.",
      },
    ],
  },

  // ------------------------------------------------------------ business-use
  {
    id: "business-use",
    name: "business-use",
    description: "Emit system invariants to business-use for flow tracking. No-op when unset.",
    category: "observability",
    iconKey: "chart-line",
    docsUrl: "https://docs.agent-swarm.dev/integrations/business-use",
    fields: [
      {
        key: "BUSINESS_USE_API_KEY",
        label: "API key",
        type: "password",
        required: true,
        isSecret: true,
        helpText: "business-use API key. SDK enters no-op mode when this is missing.",
      },
      {
        key: "BUSINESS_USE_URL",
        label: "Backend URL",
        type: "text",
        placeholder: "https://bu.example.com",
        helpText:
          "Override the business-use backend URL (e.g. for self-hosted or local dev on :13370).",
      },
    ],
  },
];
