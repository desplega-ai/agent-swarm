// Configuration catalog — single source of truth for the /settings/configuration
// page.
//
// Each entry maps to a **non-secret** `swarm_config` row in the `global` scope
// (the same store the Integrations UI writes to). Env vars win at boot; a value
// saved here becomes effective after the server's debounced auto-reload (or the
// explicit "Reload config" button). Entries flagged `restartRequired` are read
// once at process start and need a full server restart.
//
// Reserved keys (`API_KEY`, `SECRETS_ENCRYPTION_KEY`) and anything
// credential-shaped are intentionally NOT listed here — secrets belong on the
// Integrations / Secrets pages, and the server rejects reserved keys outright
// (see `src/be/swarm-config-guard.ts`).

import {
  Activity,
  Brain,
  Compass,
  Cpu,
  HeartPulse,
  type LucideIcon,
  Palette,
  Plug,
  Shield,
  Workflow,
} from "lucide-react";

const DOCS = "https://docs.agent-swarm.dev/docs/";

export type ConfigCatalogKind = "boolean" | "enum" | "number" | "string";

export interface ConfigCatalogEntry {
  /** swarm_config key — also the env var name (e.g. "STEERING_ENABLED"). */
  key: string;
  label: string;
  description: string;
  kind: ConfigCatalogKind;
  /** Allowed values for `kind: "enum"`. */
  options?: string[];
  /**
   * Effective value when neither an env var nor a DB row is present. Rendered
   * as a "Default: X" hint; for boolean/enum it also seeds the control.
   */
  defaultValue?: string;
  docsUrl?: string;
  /** Read once at boot — saving is not enough, the server must restart. */
  restartRequired?: boolean;
  placeholder?: string;
}

export interface ConfigCatalogGroup {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  entries: ConfigCatalogEntry[];
}

export const CONFIGURATION_GROUPS: ConfigCatalogGroup[] = [
  {
    id: "steering",
    title: "Steering",
    description:
      "Control whether running tasks can be redirected mid-flight, and how steering messages reach the harness.",
    icon: Compass,
    entries: [
      {
        key: "STEERING_ENABLED",
        label: "Enable steering",
        description:
          "Master switch for mid-run task steering across harness providers. Off by default — every other steering setting is inert until this is on.",
        kind: "boolean",
        defaultValue: "false",
        docsUrl: `${DOCS}guides/task-steering`,
      },
      {
        key: "SLACK_THREAD_STEERING",
        label: "Slack thread steering",
        description:
          "Who may steer a running task by replying in its Slack thread — only the task's lead, or anyone in the thread.",
        kind: "enum",
        options: ["lead", "all"],
        docsUrl: `${DOCS}guides/task-steering`,
      },
      {
        key: "SLACK_THREAD_STEERING_MODE",
        label: "Slack steering delivery",
        description:
          "Deliver steering to the harness immediately, or queue it until the agent reaches its next checkpoint.",
        kind: "enum",
        options: ["steer", "queue"],
        defaultValue: "queue",
        docsUrl: `${DOCS}guides/task-steering`,
      },
    ],
  },
  {
    id: "memory",
    title: "Memory",
    description: "Retrieval, ranking, and embedding behaviour for the swarm's long-term memory.",
    icon: Brain,
    entries: [
      {
        key: "MEMORY_HYBRID_SEARCH",
        label: "Hybrid search",
        description:
          "Blend full-text (FTS) matches with vector similarity when searching memories instead of vectors alone.",
        kind: "boolean",
        defaultValue: "true",
        docsUrl: `${DOCS}architecture/memory`,
      },
      {
        key: "MEMORY_GRAPH_EXPANSION",
        label: "Graph expansion",
        description:
          "Pull in 1-hop graph neighbours of the top-ranked memories during retrieval to widen recall.",
        kind: "boolean",
        defaultValue: "true",
        docsUrl: `${DOCS}architecture/memory`,
      },
      {
        key: "MEMORY_LLM_RATER_MODEL",
        label: "LLM rater model",
        description:
          "Model used by the LLM memory raters that score candidate memories for usefulness.",
        kind: "string",
        defaultValue: "haiku",
        placeholder: "haiku",
        docsUrl: `${DOCS}architecture/memory`,
      },
      {
        key: "MEMORY_RECENCY_HALF_LIFE_DAYS",
        label: "Recency half-life (days)",
        description:
          "Global override for the recency-decay half-life. Leave unset to keep the per-memory-type defaults.",
        kind: "number",
        defaultValue: "per-type (180/14/7)",
        placeholder: "180",
        docsUrl: `${DOCS}architecture/memory`,
      },
      {
        key: "MEMORY_MIN_SIMILARITY",
        label: "Minimum similarity",
        description:
          "Minimum cosine similarity a memory must reach to be considered a retrieval candidate.",
        kind: "number",
        defaultValue: "0.1",
        placeholder: "0.1",
        docsUrl: `${DOCS}architecture/memory`,
      },
      {
        key: "MEMORY_ACCESS_BOOST_MAX",
        label: "Access boost cap",
        description:
          "Upper bound on the score multiplier applied to frequently and recently accessed memories.",
        kind: "number",
        defaultValue: "1.5",
        placeholder: "1.5",
        docsUrl: `${DOCS}architecture/memory`,
      },
      {
        key: "EMBEDDING_MODEL",
        label: "Embedding model",
        description:
          "Embedding model used to vectorize memories. Changing this invalidates existing vectors — re-embed before relying on search.",
        kind: "string",
        defaultValue: "text-embedding-3-small",
        placeholder: "text-embedding-3-small",
        docsUrl: `${DOCS}architecture/memory`,
      },
      {
        key: "MEMORY_RATERS",
        label: "Active memory raters",
        description:
          "Comma-separated list of memory raters to run — the main lever on memory scoring. Unknown names are skipped; leave unset to run no raters.",
        kind: "string",
        placeholder: "e.g. implicit-citation",
        docsUrl: `${DOCS}architecture/memory`,
      },
    ],
  },
  {
    id: "heartbeat",
    title: "Heartbeat & crash recovery",
    description:
      "Liveness sweeps, stall-detection thresholds, and how crashed or abandoned tasks are resumed.",
    icon: HeartPulse,
    entries: [
      {
        key: "HEARTBEAT_DISABLE",
        label: "Disable heartbeat",
        description:
          "Turn the heartbeat subsystem off entirely. Stalled tasks will no longer be detected or recovered.",
        kind: "boolean",
        defaultValue: "false",
        restartRequired: true,
      },
      {
        key: "HEARTBEAT_INTERVAL_MS",
        label: "Sweep interval (ms)",
        description: "How long the server waits between heartbeat sweeps.",
        kind: "number",
        defaultValue: "90000",
        placeholder: "90000",
        restartRequired: true,
      },
      {
        key: "HEARTBEAT_STALL_THRESHOLD_MIN",
        label: "Stall threshold (min)",
        description: "Minutes without any task update before a task is classified as stalled.",
        kind: "number",
        defaultValue: "30",
        placeholder: "30",
      },
      {
        key: "HEARTBEAT_STALL_NO_SESSION_MIN",
        label: "No-session threshold (min)",
        description:
          "Minutes a claimed task may go without a live session before its worker is presumed dead.",
        kind: "number",
        defaultValue: "5",
        placeholder: "5",
      },
      {
        key: "HEARTBEAT_STALL_STALE_HB_MIN",
        label: "Stale-heartbeat threshold (min)",
        description: "Minutes of stale heartbeat that hand a task to the stall classifier.",
        kind: "number",
        defaultValue: "15",
        placeholder: "15",
      },
      {
        key: "HEARTBEAT_MAX_AUTO_ASSIGN",
        label: "Max auto-assigns per sweep",
        description: "Upper bound on how many pool tasks a single heartbeat sweep may auto-assign.",
        kind: "number",
        defaultValue: "5",
        placeholder: "5",
      },
      {
        key: "HEARTBEAT_MAX_RESUME_GENERATIONS",
        label: "Max resume generations",
        description:
          "How many times crash recovery may resume the same task before it escalates instead.",
        kind: "number",
        defaultValue: "3",
        placeholder: "3",
      },
      {
        key: "HEARTBEAT_PIN_CRASH_RESUME",
        label: "Pin crash resumes",
        description:
          "Route a crash-recovery resume back to the original agent instead of returning it to the pool.",
        kind: "boolean",
        defaultValue: "true",
      },
      {
        key: "POOL_AFFINITY_ENFORCEMENT",
        label: "Enforce pool affinity",
        description:
          "Honour routing affinity (repo, skills, provider) when assigning tasks from the pool.",
        kind: "boolean",
        defaultValue: "true",
      },
    ],
  },
  {
    id: "harness",
    title: "Harness & tools",
    description:
      "The tool surface exposed to workers. Provider and model selection are configured per agent, not here — anything set globally would become the default for EVERY agent, so those knobs are deliberately left to each agent's own configuration.",
    icon: Cpu,
    entries: [
      {
        key: "SCRIPTS_ONLY_MCP",
        label: "Scripts-only MCP",
        description:
          "Restrict workers to the scripts tool surface instead of the full MCP tool registry.",
        kind: "boolean",
        defaultValue: "false",
        docsUrl: `${DOCS}guides/scripts-only-mode`,
      },
      {
        key: "CAPABILITIES",
        label: "Capability surface",
        description:
          "Comma-separated list of MCP capability groups exposed to workers (core, tasks, scripts, memory, workflows, …). Leave unset for the standard default surface; there is no wildcard value.",
        kind: "string",
        placeholder: "core,tasks,scripts,memory,workflows",
      },
      {
        key: "WORKER_API_READY_TIMEOUT_SECONDS",
        label: "API readiness timeout (s)",
        description:
          "How long docker-entrypoint.sh waits for the control-plane API's /health endpoint before exiting the worker/lead container non-zero. This is a bootstrap-only setting read from the container's environment before the API is reachable — saving a value here documents and validates the intended deployment env var, it cannot affect a container that is already waiting.",
        kind: "number",
        defaultValue: "90",
        placeholder: "90",
        restartRequired: true,
        docsUrl: `${DOCS}ui/configuration`,
      },
    ],
  },
  {
    id: "integrations",
    title: "Integrations",
    description:
      "Kill switches for the built-in integrations. Credentials themselves are managed on the Integrations page.",
    icon: Plug,
    entries: [
      {
        key: "SLACK_DISABLE",
        label: "Disable Slack",
        description:
          "Stop the Slack handler from starting. Credentials stay untouched — manage them on the Integrations page.",
        kind: "boolean",
        defaultValue: "false",
        docsUrl: `${DOCS}guides/slack-integration`,
      },
      {
        key: "GITHUB_DISABLE",
        label: "Disable GitHub",
        description:
          "Stop the GitHub handler from starting. Credentials stay untouched — manage them on the Integrations page.",
        kind: "boolean",
        defaultValue: "false",
        docsUrl: `${DOCS}guides/github-integration`,
      },
      {
        key: "GITLAB_DISABLE",
        label: "Disable GitLab",
        description:
          "Stop the GitLab handler from starting. Credentials stay untouched — manage them on the Integrations page.",
        kind: "boolean",
        defaultValue: "false",
        docsUrl: `${DOCS}guides/gitlab-integration`,
      },
      {
        key: "LINEAR_DISABLE",
        label: "Disable Linear",
        description:
          "Stop the Linear handler from starting. Credentials stay untouched — manage them on the Integrations page.",
        kind: "boolean",
        defaultValue: "false",
        docsUrl: `${DOCS}integrations/linear`,
      },
      {
        key: "JIRA_DISABLE",
        label: "Disable Jira",
        description:
          "Stop the Jira handler from starting. Credentials stay untouched — manage them on the Integrations page.",
        kind: "boolean",
        defaultValue: "false",
        docsUrl: `${DOCS}guides/jira-integration`,
      },
      {
        key: "AGENTMAIL_DISABLE",
        label: "Disable AgentMail",
        description:
          "Stop the AgentMail handler from starting. Credentials stay untouched — manage them on the Integrations page.",
        kind: "boolean",
        defaultValue: "false",
        docsUrl: `${DOCS}guides/agentmail-integration`,
      },
      {
        key: "ADDITIVE_SLACK",
        label: "Additive Slack mode",
        description:
          "Batch consecutive messages in a Slack thread into a single task update instead of one per message.",
        kind: "boolean",
        defaultValue: "false",
        docsUrl: `${DOCS}guides/slack-integration`,
      },
      {
        key: "SLACK_ALERTS_CHANNEL",
        label: "Slack alerts channel",
        description:
          "Channel operational alerts are posted to. Accepts a channel ID or name; leave unset to disable alerting.",
        kind: "string",
        placeholder: "e.g. C0123456789",
        docsUrl: `${DOCS}guides/slack-integration`,
      },
      {
        key: "SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION",
        label: "Require mention for follow-ups",
        description:
          "Only treat a Slack thread reply as a follow-up when the bot is @-mentioned. Off means every reply in the thread is picked up.",
        kind: "boolean",
        defaultValue: "false",
        docsUrl: `${DOCS}guides/slack-integration`,
      },
      {
        key: "LINEAR_ALLOWED_STATES",
        label: "Linear pickup states",
        description:
          "Comma-separated Linear workflow state types eligible for swarm pickup. Leave unset for the default `unstarted,started,completed,canceled` — which excludes `triage` and `backlog`.",
        kind: "string",
        defaultValue: "unstarted,started,completed,canceled",
        placeholder: "unstarted,started,completed,canceled",
        docsUrl: `${DOCS}integrations/linear`,
      },
      {
        key: "LINEAR_SWARM_READY_LABEL",
        label: "Linear swarm-ready label",
        description:
          "Label that marks a Linear issue as ready for the swarm to pick up. Leave unset to skip label filtering.",
        kind: "string",
        placeholder: "e.g. swarm-ready",
        docsUrl: `${DOCS}integrations/linear`,
      },
    ],
  },
  {
    id: "security",
    title: "Security & access",
    description: "Role-based access control, audit logging, budget admission, and telemetry.",
    icon: Shield,
    entries: [
      {
        key: "RBAC_ENABLED",
        label: "Enable RBAC",
        description:
          "Enforce role-based access control on the API and MCP surfaces. Off means every authenticated caller is granted all permissions.",
        kind: "boolean",
        defaultValue: "false",
      },
      {
        key: "RBAC_AUDIT_DISABLED",
        label: "Disable RBAC audit log",
        description:
          "Stop writing RBAC decisions to the audit log. Useful for high-volume deployments where the log is noise.",
        kind: "boolean",
        defaultValue: "false",
      },
      {
        key: "RBAC_AUDIT_RETENTION_DAYS",
        label: "Audit retention (days)",
        description: "How long RBAC audit log entries are kept before being pruned.",
        kind: "number",
        defaultValue: "30",
        placeholder: "30",
      },
      {
        key: "MCP_OAUTH_ALLOW_PRIVATE_HOSTS",
        label: "Allow private hosts in MCP OAuth",
        description:
          "Let MCP OAuth flows target private-network hosts, overriding the SSRF guard. Enable only for trusted local development.",
        kind: "boolean",
        defaultValue: "false",
      },
      {
        key: "BUDGET_ADMISSION_DISABLED",
        label: "Disable budget admission",
        description:
          "Skip budget admission control so tasks are admitted even when their budget is exhausted.",
        kind: "boolean",
        defaultValue: "false",
      },
    ],
  },
  {
    id: "workflows",
    title: "Workflows & scheduler",
    description: "Execution limits for workflow runs and the cadence of the scheduler loop.",
    icon: Workflow,
    entries: [
      {
        key: "WORKFLOW_MAX_ITERATIONS",
        label: "Max iterations per run",
        description:
          "Hard ceiling on loop iterations in a single workflow run before it is failed as runaway.",
        kind: "number",
        defaultValue: "100",
        placeholder: "100",
      },
      {
        key: "WORKFLOW_MAX_STEPS_PER_RUN",
        label: "Max steps per run",
        description: "Hard ceiling on the number of node executions in a single workflow run.",
        kind: "number",
        defaultValue: "500",
        placeholder: "500",
      },
      {
        key: "SCHEDULER_INTERVAL_MS",
        label: "Scheduler tick (ms)",
        description: "How often the scheduler wakes up to evaluate due schedules.",
        kind: "number",
        defaultValue: "10000",
        placeholder: "10000",
        restartRequired: true,
      },
      {
        key: "SCRIPT_RUN_CONCURRENCY_CAP",
        label: "Script run concurrency cap",
        description:
          "Maximum number of script runs executing at once. Leave unset for the default cap of 10.",
        kind: "number",
        defaultValue: "10",
        placeholder: "10",
      },
    ],
  },
  {
    id: "telemetry",
    title: "Telemetry & observability",
    description:
      "OpenTelemetry export for traces and metrics, plus the anonymized usage telemetry opt-out.",
    icon: Activity,
    entries: [
      {
        key: "OTEL_EXPORTER_OTLP_ENDPOINT",
        label: "OTLP endpoint",
        description:
          "Collector endpoint traces and metrics are exported to. Leave unset to disable OTLP export.",
        kind: "string",
        placeholder: "http://localhost:4318",
        restartRequired: true,
        docsUrl: `${DOCS}guides/observability-opentelemetry`,
      },
      {
        key: "OTEL_SERVICE_NAME",
        label: "Service name",
        description:
          "Service name reported to the OTLP collector, used to group spans and metrics.",
        kind: "string",
        defaultValue: "agent-swarm",
        placeholder: "agent-swarm",
        restartRequired: true,
        docsUrl: `${DOCS}guides/observability-opentelemetry`,
      },
      {
        key: "OTEL_TRACE_POLL",
        label: "Trace poll loop",
        description:
          "Include the worker poll-loop spans in tracing. High volume — enable only while debugging polling.",
        kind: "boolean",
        defaultValue: "false",
        docsUrl: `${DOCS}guides/observability-opentelemetry`,
      },
      {
        key: "ANONYMIZED_TELEMETRY",
        label: "Anonymized telemetry",
        description:
          "Send anonymized usage telemetry to help improve Agent Swarm. Set to false to opt out.",
        kind: "boolean",
        defaultValue: "true",
      },
    ],
  },
  {
    id: "branding",
    title: "Branding & URLs",
    description:
      "Organization identity shown across the dashboard, the public status page, and outbound links.",
    icon: Palette,
    entries: [
      {
        key: "SWARM_ORG_NAME",
        label: "Organization name",
        description: "Name shown in the dashboard header, the status page, and outbound messages.",
        kind: "string",
        defaultValue: "Swarm",
        placeholder: "Swarm",
        docsUrl: `${DOCS}guides/personalization`,
      },
      {
        key: "SWARM_BRAND_COLOR",
        label: "Brand accent color",
        description:
          "Accent color used for branded surfaces. Hex notation, including the leading hash.",
        kind: "string",
        placeholder: "#RRGGBB",
        docsUrl: `${DOCS}guides/personalization`,
      },
      {
        key: "SWARM_ORG_LOGO_URL",
        label: "Organization logo URL",
        description: "Publicly reachable URL of the logo shown alongside the organization name.",
        kind: "string",
        placeholder: "https://example.com/logo.svg",
        docsUrl: `${DOCS}guides/personalization`,
      },
      {
        key: "DASHBOARD_URL",
        label: "Dashboard URL",
        description:
          "Public URL of this dashboard. Used to build deep links in Slack, email, and other outbound messages.",
        kind: "string",
        placeholder: "https://swarm.example.com",
      },
      {
        key: "SWARM_HIDE_CLOUD_PROMO",
        label: "Hide cloud promotion",
        description: "Suppress cloud upsell messaging in the dashboard.",
        kind: "boolean",
        defaultValue: "false",
        docsUrl: `${DOCS}guides/personalization`,
      },
      {
        key: "TEMPLATE_REGISTRY_URL",
        label: "Template registry URL",
        description:
          "Endpoint for shareable task and workflow templates. Workers fetch their template once at startup and cache it, so running workers keep the old registry until restarted.",
        kind: "string",
        defaultValue: "https://templates.agent-swarm.dev",
        placeholder: "https://templates.agent-swarm.dev",
        restartRequired: true,
      },
    ],
  },
];

/** Every key in the catalog — used for a single env-presence request. */
export const CONFIGURATION_KEYS: string[] = CONFIGURATION_GROUPS.flatMap((g) =>
  g.entries.map((e) => e.key),
);
