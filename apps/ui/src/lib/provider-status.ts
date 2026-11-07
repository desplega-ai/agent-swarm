// One status per work-tool provider for Connect › Tools.
//
// A provider can be set up through three storage families: `swarm_config`
// keys (the integration form), an OAuth app with its authorizations
// (`oauth_apps` + `oauth_authorizations`), and script connections. The
// backend keeps them apart. This module merges them for the UI only.

import type { OAuthAppSummary, ScriptConnection, SwarmConfig } from "../api/types";
import type { IntegrationDef } from "./integrations-catalog";
import {
  deriveIntegrationStatus,
  type EnvPresence,
  type IntegrationStatus,
  type LiveIntegrationState,
} from "./integrations-status";
import { matchScriptConnection } from "./tools-search";

export type ProviderOAuthState = "none" | "app" | "authorized";

export interface ProviderStatus {
  /**
   * The integration status from `swarm_config` and the deploy env. For a
   * provider with OAuth only (Gmail, Microsoft 365), "configured" once an
   * OAuth app exists.
   */
  configured: IntegrationStatus;
  /** "app": an OAuth app exists. "authorized": an account is signed in. */
  oauth: ProviderOAuthState;
  /** Signed-in accounts (active authorizations) across the provider's apps. */
  accounts: number;
  /** Script connections that match `scriptConnectionTerm(def)`. */
  scriptConnections: number;
}

export interface ProviderStatusInputs {
  configs: SwarmConfig[];
  presence: EnvPresence;
  oauthApps: OAuthAppSummary[];
  scriptConnections: ScriptConnection[];
  live?: LiveIntegrationState;
}

/** Tool cards that have no `swarm_config` keys: the OAuth presets `google` and `microsoft`. */
export const OAUTH_ONLY_TOOLS: IntegrationDef[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Read and send mail from a connected Google account.",
    category: "email",
    iconKey: "mail",
    logoSrc: "/integration-logos/gmail.svg",
    docsUrl: "https://developers.google.com/identity/protocols/oauth2",
    fields: [],
  },
  {
    id: "microsoft-365",
    name: "Microsoft 365",
    description: "Outlook mail, Teams and files for a work account.",
    category: "email",
    iconKey: "mail",
    logoSrc: "/integration-logos/microsoft.svg",
    docsUrl: "https://learn.microsoft.com/en-us/graph/auth-v2-user",
    fields: [],
  },
];

/** The OAuth preset provider behind a tool card. Other cards have no OAuth app. */
export const OAUTH_PROVIDER_BY_TOOL: Readonly<Record<string, string>> = {
  github: "github",
  jira: "jira",
  linear: "linear",
  slack: "slack",
  gmail: "google",
  "microsoft-365": "microsoft",
};

/** Search terms that differ from the card id (the API host of the provider). */
const SCRIPT_CONNECTION_TERMS: Readonly<Record<string, string>> = {
  jira: "atlassian",
  "microsoft-365": "microsoft",
  gsc: "searchconsole",
};

/**
 * The word that a provider's script connections carry in their slug, name
 * or base URL. The "N script connections" link opens the Script connections
 * tab with this word as its search, so the count and the list agree.
 */
export function scriptConnectionTerm(def: Pick<IntegrationDef, "id">): string {
  return SCRIPT_CONNECTION_TERMS[def.id] ?? def.id;
}

export function deriveProviderStatus(
  def: IntegrationDef,
  { configs, presence, oauthApps, scriptConnections, live }: ProviderStatusInputs,
): ProviderStatus {
  const provider = OAUTH_PROVIDER_BY_TOOL[def.id];
  const apps = provider ? oauthApps.filter((app) => app.provider === provider) : [];
  const accounts = apps.reduce(
    (sum, app) => sum + app.authorizations.filter((auth) => auth.status === "active").length,
    0,
  );
  const oauth: ProviderOAuthState =
    apps.length === 0 ? "none" : accounts > 0 ? "authorized" : "app";
  const oauthOnly = OAUTH_ONLY_TOOLS.some((tool) => tool.id === def.id);
  const configured: IntegrationStatus = oauthOnly
    ? oauth === "none"
      ? "none"
      : "configured"
    : deriveIntegrationStatus(def, configs, presence, live);
  const term = scriptConnectionTerm(def);
  return {
    configured,
    oauth,
    accounts,
    scriptConnections: scriptConnections.filter((connection) =>
      matchScriptConnection(connection, term),
    ).length,
  };
}

/** A provider is in use when any of its storage families holds something. */
export function isProviderInUse(status: ProviderStatus): boolean {
  return status.configured !== "none" || status.oauth !== "none" || status.scriptConnections > 0;
}
