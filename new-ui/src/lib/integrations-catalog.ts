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

export type IntegrationCategory =
  | "comm"
  | "issues"
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

export interface IntegrationDef {
  /** URL slug (kebab-case). Must be unique. */
  id: string;
  name: string;
  description: string;
  category: IntegrationCategory;
  /** Maps to a lucide-react icon name at render time. */
  iconKey: string;
  /** External docs URL or in-repo docs path. */
  docsUrl: string;
  fields: IntegrationField[];
  /** Env var that disables the integration (e.g. "SLACK_DISABLE"). */
  disableKey?: string;
  /** Changes require API server restart to take effect. */
  restartRequired?: boolean;
  /** Custom flow that overrides the generic field form. */
  specialFlow?: IntegrationSpecialFlow;
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
    fields: [
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
        placeholder: "claude-sonnet-4-6",
        helpText: "Optional override. Defaults to claude-sonnet-4-6.",
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
