/**
 * Curated OAuth presets.
 *
 * Pure, static data — NO database or network access — so this module can be
 * imported from HTTP handlers, MCP tools, and CLI code alike. Each preset
 * generalizes the provider-specific OAuth quirks (endpoints, scope joining,
 * token-endpoint auth style/body format, refresh-token rotation, and any
 * authorization-URL extra params) that used to live in hardcoded per-provider
 * builders. Client credentials are NEVER shipped here: customers always bring
 * their own `clientId`/`clientSecret`.
 *
 * The `setupHints` on each preset are human-readable operator notes surfaced by
 * pickers and by the app-creation response.
 */

export interface OAuthPreset {
  /** Stable preset identifier referenced by the catalog manifest + pickers. */
  id: string;
  /** Human-friendly provider name. */
  displayName: string;
  /** Default provider slug used when the caller omits one. */
  provider: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** RFC 7009 revocation endpoint, when the provider exposes one. */
  revocationUrl?: string;
  /** Identity-capture hint endpoint (OIDC userinfo or equivalent). */
  userinfoUrl?: string;
  /** Sensible default scopes; customers routinely override/extend these. */
  scopes: string[];
  /**
   * How `scopes` are joined in the authorization URL. RFC 6749 default is a
   * space; some providers (Linear, Slack) require a comma.
   */
  scopeSeparator?: string;
  /** `"basic"` when the token endpoint needs HTTP Basic client auth. */
  tokenAuthStyle?: "body" | "basic";
  /** `"json"` when the token endpoint needs a JSON (not form) request body. */
  tokenBodyFormat?: "form" | "json";
  /** Provider rotates refresh tokens on every refresh (fail loudly if absent). */
  requiresRefreshTokenRotation?: boolean;
  /** Extra params appended to the authorization URL (e.g. Google offline access). */
  extraParams?: Record<string, string>;
  /** Operator-facing quirk notes surfaced in pickers + the creation response. */
  setupHints: string[];
}

/**
 * Fields a caller may supply explicitly to override a preset. Every field is
 * optional; anything omitted is filled from the preset.
 */
export interface OAuthPresetOverrides {
  provider?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  revocationUrl?: string | null;
  userinfoUrl?: string | null;
  scopes?: string[];
  scopeSeparator?: string;
  tokenAuthStyle?: "body" | "basic";
  tokenBodyFormat?: "form" | "json";
  requiresRefreshTokenRotation?: boolean;
  extraParams?: Record<string, string>;
}

/** Result of merging a preset with explicit overrides. */
export interface HydratedOAuthApp {
  provider: string;
  authorizeUrl: string;
  tokenUrl: string;
  revocationUrl?: string | null;
  userinfoUrl?: string | null;
  scopes: string[];
  scopeSeparator?: string;
  tokenAuthStyle?: "body" | "basic";
  tokenBodyFormat?: "form" | "json";
  requiresRefreshTokenRotation?: boolean;
  extraParams?: Record<string, string>;
  source: "curated-prefill";
  setupHints: string[];
}

const OAUTH_PRESETS: readonly OAuthPreset[] = [
  {
    id: "google",
    displayName: "Google",
    provider: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revocationUrl: "https://oauth2.googleapis.com/revoke",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
    scopeSeparator: " ",
    tokenAuthStyle: "body",
    tokenBodyFormat: "form",
    extraParams: { access_type: "offline", prompt: "consent" },
    setupHints: [
      "Google only returns a refresh token when access_type=offline and prompt=consent are sent — this preset includes both so refresh tokens exist at all.",
      "The default scopes cover identity only. Add the product scopes you actually need (e.g. Gmail: https://www.googleapis.com/auth/gmail.modify).",
      "Create the OAuth client in Google Cloud Console → APIs & Services → Credentials and add the swarm redirect URI to the client's authorized redirect URIs.",
    ],
  },
  {
    id: "slack",
    displayName: "Slack",
    provider: "slack",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    revocationUrl: "https://slack.com/api/auth.revoke",
    userinfoUrl: "https://slack.com/api/auth.test",
    scopes: ["channels:history", "channels:read", "chat:write"],
    scopeSeparator: ",",
    tokenAuthStyle: "body",
    tokenBodyFormat: "form",
    setupHints: [
      "Slack expects comma-separated scopes in the authorize URL — this preset sets that separator.",
      "The listed scopes are bot-token scopes; add user-token scopes separately in the Slack app config if you need them.",
      "Register the app at api.slack.com/apps and add the swarm redirect URI under OAuth & Permissions.",
    ],
  },
  {
    id: "github",
    displayName: "GitHub",
    provider: "github",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userinfoUrl: "https://api.github.com/user",
    scopes: ["repo", "read:org", "read:user"],
    scopeSeparator: " ",
    tokenAuthStyle: "body",
    tokenBodyFormat: "form",
    setupHints: [
      "Classic GitHub OAuth apps issue long-lived tokens with no expiry and no refresh token; use a GitHub App instead if you need rotation.",
      "GitHub's token endpoint returns form-encoded data unless the request sends Accept: application/json.",
      "Register at github.com/settings/developers → OAuth Apps and set the swarm redirect URI as the Authorization callback URL.",
    ],
  },
  {
    id: "jira",
    displayName: "Jira (Atlassian)",
    provider: "jira",
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scopes: ["read:jira-work", "write:jira-work", "read:jira-user", "offline_access"],
    scopeSeparator: " ",
    tokenAuthStyle: "body",
    tokenBodyFormat: "form",
    requiresRefreshTokenRotation: true,
    extraParams: { audience: "api.atlassian.com", prompt: "consent" },
    setupHints: [
      "Atlassian 3LO rotates refresh tokens on every refresh — this preset enables rotation enforcement so a refresh that omits a new token fails loudly instead of silently invalidating the grant.",
      "Include the offline_access scope or you won't receive a refresh token; audience=api.atlassian.com is required and set here.",
      "Refresh tokens expire after 90 days of inactivity — the swarm keep-alive sweep refreshes idle grants to stay ahead of this.",
      "Jira is a reserved provider: configure it through the dedicated tracker integration flow, not the generic OAuth apps route.",
    ],
  },
  {
    id: "linear",
    displayName: "Linear",
    provider: "linear",
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    revocationUrl: "https://api.linear.app/oauth/revoke",
    scopes: ["read", "write"],
    scopeSeparator: ",",
    tokenAuthStyle: "body",
    tokenBodyFormat: "form",
    extraParams: { actor: "app" },
    setupHints: [
      "Linear requires comma-separated scopes in the authorize URL — this preset sets that separator.",
      "actor=app makes the swarm act as the application; set actor=user to act on behalf of the authorizing user.",
      "Linear is a reserved provider: configure it through the dedicated tracker integration flow, not the generic OAuth apps route.",
    ],
  },
  {
    id: "notion",
    displayName: "Notion",
    provider: "notion",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    scopeSeparator: " ",
    tokenAuthStyle: "basic",
    tokenBodyFormat: "json",
    extraParams: { owner: "user" },
    setupHints: [
      "Notion's token endpoint requires HTTP Basic client authentication and a JSON request body — this preset sets tokenAuthStyle=basic and tokenBodyFormat=json.",
      "Notion has no OAuth scopes; capability is configured on the integration in Notion's developer settings.",
      "owner=user is required to receive a user-scoped token and is set here.",
    ],
  },
];

/** All curated presets (stable order). */
export function listOAuthPresets(): OAuthPreset[] {
  return OAUTH_PRESETS.map((preset) => ({ ...preset }));
}

/** All valid preset ids, for validation error messages + pickers. */
export function listOAuthPresetIds(): string[] {
  return OAUTH_PRESETS.map((preset) => preset.id);
}

/** Look up a preset by id, or `null` when unknown. */
export function getOAuthPreset(id: string): OAuthPreset | null {
  return OAUTH_PRESETS.find((preset) => preset.id === id) ?? null;
}

function mergeExtraParams(
  base: Record<string, string> | undefined,
  override: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

/**
 * Merge a preset with explicit caller overrides. Explicit fields always win;
 * `extraParams` merges per-key (override keys replace preset keys). The result
 * is always tagged `source: 'curated-prefill'`.
 */
export function hydrateOAuthAppFromPreset(
  preset: OAuthPreset,
  overrides: OAuthPresetOverrides = {},
): HydratedOAuthApp {
  return {
    provider: overrides.provider ?? preset.provider,
    authorizeUrl: overrides.authorizeUrl ?? preset.authorizeUrl,
    tokenUrl: overrides.tokenUrl ?? preset.tokenUrl,
    revocationUrl: overrides.revocationUrl ?? preset.revocationUrl,
    userinfoUrl: overrides.userinfoUrl ?? preset.userinfoUrl,
    scopes: overrides.scopes ?? [...preset.scopes],
    scopeSeparator: overrides.scopeSeparator ?? preset.scopeSeparator,
    tokenAuthStyle: overrides.tokenAuthStyle ?? preset.tokenAuthStyle,
    tokenBodyFormat: overrides.tokenBodyFormat ?? preset.tokenBodyFormat,
    requiresRefreshTokenRotation:
      overrides.requiresRefreshTokenRotation ?? preset.requiresRefreshTokenRotation,
    extraParams: mergeExtraParams(preset.extraParams, overrides.extraParams),
    source: "curated-prefill",
    setupHints: [...preset.setupHints],
  };
}
