import type { StatusAutomation } from "../api/types";

const PARAMETER_LABELS: Record<string, string> = {
  ALERTS_CHANNEL_ID: "an alerts channel",
  AGENT_FS_ORG_ID: "an AgentFS organization ID",
  BRANCH: "a branch",
  COMPETITORS: "a competitor list",
  GSC_PROPERTY: "a Google Search Console property",
  ORG_ID: "an organization ID",
  PAGE_ID: "a page ID",
  PR_REVIEWER: "a pull-request reviewer",
  REPO_URL: "a repository URL",
  REPORT_EMAIL: "a report email address",
  REPORT_NAME: "a report name",
  SLACK_CHANNEL_ID: "a Slack channel",
  SCOPE_PATH: "a scope path",
  TAG_PATTERN: "a tag pattern",
  TIMEZONE: "a timezone",
};

const INTEGRATION_LABELS: Record<string, string> = {
  agentfs: "AgentFS",
  agentmail: "AgentMail",
  github: "GitHub",
  gsc: "Google Search Console",
  jira: "Jira",
  linear: "Linear",
  slack: "Slack",
};

const IDENTIFIER_WORDS: Record<string, string> = {
  dora: "DORA",
  gsc: "Google Search Console",
  hn: "Hacker News",
  llm: "LLM",
  pr: "PR",
  ux: "UX",
};

function joinHuman(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

export function automationDisplayName(automation: Pick<StatusAutomation, "name">): string {
  return automation.name
    .split("-")
    .map(
      (word) => IDENTIFIER_WORDS[word.toLowerCase()] ?? `${word[0]?.toUpperCase()}${word.slice(1)}`,
    )
    .join(" ");
}

export function automationMissingItems(automation: StatusAutomation): string[] {
  return [...automation.missing.params, ...automation.missing.integrations];
}

export function automationMissingSummary(automation: StatusAutomation): string {
  const params = automation.missing.params.map(
    (param) => PARAMETER_LABELS[param] ?? param.replaceAll("_", " ").toLowerCase(),
  );
  const integrations = automation.missing.integrations.map(
    (integration) => INTEGRATION_LABELS[integration] ?? integration,
  );
  return joinHuman([...params, ...integrations]);
}

export function automationPurpose(automation: StatusAutomation): string {
  const name = automationDisplayName(automation);
  return automation.kind === "schedule"
    ? `${name} runs on its configured schedule.`
    : `${name} runs when its configured trigger fires.`;
}

export function automationFixText(automation: StatusAutomation): string {
  const params = automation.missing.params.map(
    (param) => PARAMETER_LABELS[param] ?? param.replaceAll("_", " ").toLowerCase(),
  );
  const integrations = automation.missing.integrations.map(
    (integration) => INTEGRATION_LABELS[integration] ?? integration,
  );
  const actions = [
    params.length > 0 && `Set ${joinHuman(params)}`,
    integrations.length > 0 && `connect ${joinHuman(integrations)}`,
  ].filter((action): action is string => Boolean(action));
  return actions.length > 0 ? `${joinHuman(actions)}.` : "Review this automation's setup.";
}

export function findAutomation(
  automations: StatusAutomation[] | undefined,
  kind: StatusAutomation["kind"],
  ...names: Array<string | undefined>
): StatusAutomation | undefined {
  return automations?.find(
    (automation) => automation.kind === kind && names.some((name) => name === automation.name),
  );
}

export function isAutomationSetupError(error: string | undefined): boolean {
  return error?.startsWith("needs_setup:") ?? false;
}
