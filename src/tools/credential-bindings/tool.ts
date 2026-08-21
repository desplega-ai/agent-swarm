import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import {
  createOAuthApp,
  getOAuthAppIdByProvider,
  listAuthorizationsForApp,
} from "@/be/db-queries/oauth";
import {
  getOAuthBindingTokenStatus,
  getOAuthProviderConfig,
  type OAuthBindingTokenStatus,
} from "@/be/oauth-credential-bindings";
import {
  disableCredentialBinding,
  listRelationalCredentialBindings,
  type ScriptCredentialBindingRecord,
  upsertCredentialBinding,
} from "@/be/script-connections";
import { assertOAuthAppUrlsSafe } from "@/oauth/app-validation";
import { getOAuthPreset, hydrateOAuthAppFromPreset, listOAuthPresetIds } from "@/oauth/presets";
import { buildAuthorizationUrl } from "@/oauth/wrapper";
import { can } from "@/rbac";
import {
  CredentialBindingSchema,
  placeholderForConfigKey,
} from "@/scripts-runtime/credential-broker";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { getPublicMcpBaseUrl } from "@/utils/constants";
import { resolveScopedResourceId, scopedResourceScopeIdSchema } from "@/utils/scoped-resource";

const providerSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_-]+$/);
const tokenStatusSchema = z.enum(["ok", "expiring", "refresh-failed", "revoked", "missing"]);
const credentialBindingToolBindingSchema = z.looseObject({
  configKey: z.string().optional(),
  allowedHosts: z.array(z.string()).optional(),
  headerTemplate: z.string().optional(),
  queryTemplate: z.string().optional(),
  scope: z.enum(["global", "agent", "repo"]).optional(),
  scopeId: z.string().nullable().optional(),
  active: z.boolean().optional(),
  authKind: z.enum(["config", "oauth"]).optional(),
  oauthAuthorizationId: z.string().optional(),
  id: z.string().optional(),
  source: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  createdBy: z.string().nullable().optional(),
  updatedBy: z.string().nullable().optional(),
  tokenStatus: tokenStatusSchema.optional(),
});

const credentialBindingsOutputSchema = swarmToolOutputSchema({
  yourAgentId: z.string().optional(),
  provider: z.string().optional(),
  authorizeUrl: z.string().optional(),
  redirectUri: z.string().optional(),
  state: z.string().optional(),
  label: z.string().optional(),
  authorizations: z
    .array(
      z.looseObject({
        id: z.string().optional(),
        label: z.string().optional(),
        accountEmail: z.string().nullable().optional(),
        status: z.string().optional(),
        expiresAt: z.string().nullable().optional(),
        scope: z.string().nullable().optional(),
      }),
    )
    .optional(),
  setupHints: z.array(z.string()).optional(),
  bindings: z.array(credentialBindingToolBindingSchema).optional(),
});

const credentialBindingsInputSchema = z.object({
  action: z
    .enum([
      "list",
      "upsert",
      "disable",
      "oauth-app-upsert",
      "oauth-authorize-url",
      "oauth-authorizations-list",
    ])
    .describe(
      "List, add/update, disable, register/authorize OAuth apps, or list an app's authorizations.",
    ),
  id: z
    .string()
    .uuid()
    .optional()
    .describe("Existing credential binding ID for update or disable."),
  configKey: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Swarm config key whose secret value is injected through templates."),
  allowedHosts: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe("Allowed outbound hostnames for this binding."),
  headerTemplate: z
    .string()
    .min(1)
    .optional()
    .describe("Header template containing the config-key placeholder."),
  queryTemplate: z
    .string()
    .min(1)
    .optional()
    .describe("Query parameter template containing the config-key placeholder."),
  scope: z
    .enum(["global", "agent", "repo"])
    .default("global")
    .optional()
    .describe("Binding visibility scope."),
  scopeId: scopedResourceScopeIdSchema
    .nullable()
    .optional()
    .describe("Agent UUID for agent scope or repo id (owner/name) for repo scope."),
  authKind: z
    .enum(["config", "oauth"])
    .default("config")
    .optional()
    .describe("Use config for stored swarm config secrets or oauth for OAuth token resolution."),
  oauthAuthorizationId: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("OAuth authorization ID required when authKind is oauth."),
  presetId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Curated OAuth preset id (e.g. google, slack, github) for oauth-app-upsert. Fills endpoints/scopes/quirks; explicit fields still win. Only clientId + clientSecret are then required.",
    ),
  provider: providerSchema
    .optional()
    .describe(
      "OAuth provider slug for oauth-app-upsert, oauth-authorize-url, and oauth-authorizations-list.",
    ),
  label: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Authorization label for oauth-authorize-url (defaults to 'default'). N per app."),
  clientId: z.string().min(1).optional().describe("OAuth client ID for oauth-app-upsert."),
  clientSecret: z.string().min(1).optional().describe("OAuth client secret for oauth-app-upsert."),
  authorizeUrl: z
    .string()
    .url()
    .optional()
    .describe("OAuth authorization URL for oauth-app-upsert."),
  tokenUrl: z.string().url().optional().describe("OAuth token URL for oauth-app-upsert."),
  userinfoUrl: z
    .string()
    .url()
    .optional()
    .describe("OIDC userinfo endpoint for identity capture (SSRF-validated)."),
  revocationUrl: z
    .string()
    .url()
    .optional()
    .describe("RFC 7009 revocation endpoint (SSRF-validated)."),
  scopes: z.array(z.string().min(1)).optional().describe("OAuth scopes for oauth-app-upsert."),
  extraParams: z
    .record(z.string(), z.string())
    .optional()
    .describe("Extra OAuth authorization parameters stored with the OAuth app."),
  tokenAuthStyle: z
    .enum(["body", "basic"])
    .optional()
    .describe(
      "How client credentials reach the token endpoint: body params (default) or HTTP Basic auth (required by e.g. Notion).",
    ),
  tokenBodyFormat: z
    .enum(["form", "json"])
    .optional()
    .describe(
      "Token request body encoding: form-urlencoded (default) or JSON (required by e.g. Notion).",
    ),
});

type BindingWithTokenStatus = ScriptCredentialBindingRecord & {
  tokenStatus?: OAuthBindingTokenStatus;
};

function staticOAuthCallbackUri(): string {
  return `${getPublicMcpBaseUrl()}/api/oauth/callback`;
}

async function decorateBindings(
  bindings: ScriptCredentialBindingRecord[],
): Promise<BindingWithTokenStatus[]> {
  return Promise.all(
    bindings.map(async (binding) =>
      binding.authKind === "oauth"
        ? {
            ...binding,
            tokenStatus: binding.oauthAuthorizationId
              ? await getOAuthBindingTokenStatus(binding.oauthAuthorizationId)
              : "missing",
          }
        : binding,
    ),
  );
}

function bindingStatusLabel(binding: BindingWithTokenStatus): string {
  if (binding.authKind === "oauth") return binding.tokenStatus ?? "missing";
  return binding.active ? "ok" : "disabled";
}

function renderBindingsList(bindings: BindingWithTokenStatus[]): string | undefined {
  if (bindings.length === 0) return undefined;
  return bindings
    .map(
      (binding) =>
        `- ${binding.configKey} (source: ${binding.source}): ${bindingStatusLabel(binding)}`,
    )
    .join("\n");
}

export const registerCredentialBindingsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "credential-bindings",
    {
      title: "Credential Bindings",
      description:
        "Advanced, lead-only management for standalone scripts-runtime credential broker bindings — the escape hatch for authenticating spec-less raw fetch() egress. Most connections should embed auth inline via the script-connections tool (which auto-manages its binding); those managed bindings are hidden here. Bindings map config keys to allowed egress hosts; scripts consume them only through fetch-layer placeholder substitution.",
      annotations: { idempotentHint: true },
      inputSchema: credentialBindingsInputSchema,
      outputSchema: credentialBindingsOutputSchema,
    },
    async (args, requestInfo) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      const agent = await getAgentById(requestInfo.agentId);
      // Gate EACH action behind the same verb its HTTP counterpart uses, so a
      // custom role granting only `credential-binding.manage` can't reach the
      // OAuth app/authorization powers this tool now exposes — powers the HTTP
      // routes gate behind `oauth-app.manage` (oauth_apps_upsert) and
      // `oauth-authorization.manage` (oauth_apps_authorize_url). Base credential
      // binding + read actions keep `credential-binding.manage`.
      const requiredVerb =
        args.action === "oauth-app-upsert"
          ? "oauth-app.manage"
          : args.action === "oauth-authorize-url"
            ? "oauth-authorization.manage"
            : "credential-binding.manage";
      const denyMessage =
        requiredVerb === "oauth-app.manage"
          ? "Only the lead can manage OAuth apps."
          : requiredVerb === "oauth-authorization.manage"
            ? "Only the lead can manage OAuth authorizations."
            : "Only the lead can manage credential bindings.";
      const decision = can({
        principal: {
          kind: "agent",
          agentId: requestInfo.agentId,
          isLead: agent?.isLead ?? false,
        },
        verb: requiredVerb,
        resource: { kind: "none" },
        source: "mcp",
      });
      if (!decision.allow) {
        return toolErr(denyMessage, { data: { yourAgentId: requestInfo.agentId } });
      }

      const currentBindings = async () =>
        await decorateBindings(
          await listRelationalCredentialBindings({ includeInactive: true, excludeManaged: true }),
        );
      const bindings = await currentBindings();

      if (args.action === "oauth-app-upsert") {
        // A presetId fills endpoints/scopes/quirks; explicit fields still win.
        const preset = args.presetId ? getOAuthPreset(args.presetId) : null;
        if (args.presetId && !preset) {
          const message = `Unknown presetId "${args.presetId}". Valid preset ids: ${listOAuthPresetIds().join(", ")}.`;
          return toolErr(message, { data: { yourAgentId: requestInfo.agentId, bindings } });
        }

        const hydrated = preset
          ? hydrateOAuthAppFromPreset(preset, {
              provider: args.provider,
              authorizeUrl: args.authorizeUrl,
              tokenUrl: args.tokenUrl,
              scopes: args.scopes,
              extraParams: args.extraParams,
              tokenAuthStyle: args.tokenAuthStyle,
              tokenBodyFormat: args.tokenBodyFormat,
            })
          : null;

        const provider = hydrated?.provider ?? args.provider;
        const authorizeUrl = hydrated?.authorizeUrl ?? args.authorizeUrl;
        const tokenUrl = hydrated?.tokenUrl ?? args.tokenUrl;
        const scopes = hydrated?.scopes ?? args.scopes;
        const userinfoUrl = hydrated?.userinfoUrl ?? args.userinfoUrl ?? null;
        const revocationUrl = hydrated?.revocationUrl ?? args.revocationUrl ?? null;

        if (!provider || !args.clientId || !args.clientSecret || !authorizeUrl || !tokenUrl) {
          const message =
            "clientId, clientSecret, and (provider, authorizeUrl, tokenUrl — supplied directly or via presetId) are required for oauth-app-upsert.";
          return toolErr(message, { data: { yourAgentId: requestInfo.agentId, bindings } });
        }

        try {
          assertOAuthAppUrlsSafe({ authorizeUrl, tokenUrl, userinfoUrl, revocationUrl });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return toolErr(message, { data: { yourAgentId: requestInfo.agentId, bindings } });
        }

        const extraParams = hydrated?.extraParams ?? args.extraParams;
        const tokenAuthStyle = hydrated?.tokenAuthStyle ?? args.tokenAuthStyle;
        const tokenBodyFormat = hydrated?.tokenBodyFormat ?? args.tokenBodyFormat;

        // The MCP surface has no by-id targeting, so every call creates a fresh
        // row (N apps per provider) rather than clobbering an existing one.
        const redirectUri = staticOAuthCallbackUri();
        await createOAuthApp(provider, {
          clientId: args.clientId,
          clientSecret: args.clientSecret,
          authorizeUrl,
          tokenUrl,
          redirectUri,
          scopes: (scopes ?? []).join(","),
          ...(userinfoUrl ? { userinfoUrl } : {}),
          ...(revocationUrl ? { revocationUrl } : {}),
          ...(extraParams ? { extraParams } : {}),
          ...(tokenAuthStyle ? { tokenAuthStyle } : {}),
          ...(tokenBodyFormat ? { tokenBodyFormat } : {}),
          ...(hydrated?.scopeSeparator ? { scopeSeparator: hydrated.scopeSeparator } : {}),
          ...(hydrated?.requiresRefreshTokenRotation !== undefined
            ? { requiresRefreshTokenRotation: hydrated.requiresRefreshTokenRotation }
            : {}),
          ...(hydrated ? { source: hydrated.source } : {}),
        });

        const details = [
          `Redirect URI: ${redirectUri}`,
          hydrated && hydrated.setupHints.length > 0
            ? `Setup hints:\n${hydrated.setupHints.map((hint) => `- ${hint}`).join("\n")}`
            : undefined,
        ]
          .filter((part): part is string => Boolean(part))
          .join("\n\n");

        return toolOk(`OAuth app ${provider} saved.`, {
          details,
          data: {
            yourAgentId: requestInfo.agentId,
            provider,
            redirectUri,
            ...(hydrated ? { setupHints: hydrated.setupHints } : {}),
            bindings: await currentBindings(),
          },
        });
      }

      if (args.action === "oauth-authorize-url") {
        if (!args.provider) {
          return toolErr("provider is required for oauth-authorize-url.", {
            data: { yourAgentId: requestInfo.agentId, bindings },
          });
        }

        const config = await getOAuthProviderConfig(args.provider);
        if (!config) {
          return toolErr(`OAuth app ${args.provider} is not configured.`, {
            data: { yourAgentId: requestInfo.agentId, provider: args.provider, bindings },
          });
        }

        const label = args.label ?? "default";
        const result = await buildAuthorizationUrl(
          { ...config, redirectUri: staticOAuthCallbackUri() },
          { label },
        );
        return toolOk(`OAuth authorization URL generated for ${args.provider} ("${label}").`, {
          details: result.url,
          data: {
            yourAgentId: requestInfo.agentId,
            provider: args.provider,
            authorizeUrl: result.url,
            redirectUri: staticOAuthCallbackUri(),
            state: result.state,
            label,
            bindings,
          },
        });
      }

      if (args.action === "oauth-authorizations-list") {
        if (!args.provider) {
          return toolErr("provider is required for oauth-authorizations-list.", {
            data: { yourAgentId: requestInfo.agentId, bindings },
          });
        }
        const appId = await getOAuthAppIdByProvider(args.provider);
        if (!appId) {
          return toolErr(`OAuth app ${args.provider} is not configured.`, {
            data: { yourAgentId: requestInfo.agentId, provider: args.provider, bindings },
          });
        }
        const authorizations = (await listAuthorizationsForApp(appId)).map((authorization) => ({
          id: authorization.id,
          label: authorization.label,
          accountEmail: authorization.accountEmail,
          status: authorization.status,
          expiresAt: authorization.expiresAt,
          scope: authorization.scope,
        }));
        return toolOk(`Found ${authorizations.length} authorization(s) for ${args.provider}.`, {
          details:
            authorizations.length > 0
              ? authorizations
                  .map(
                    (a) =>
                      `- ${a.id} "${a.label}" (${a.status}): ${a.accountEmail ?? "no email"}${a.expiresAt ? `, expires ${a.expiresAt}` : ""}`,
                  )
                  .join("\n")
              : undefined,
          data: {
            yourAgentId: requestInfo.agentId,
            provider: args.provider,
            authorizations,
            bindings,
          },
        });
      }

      if (args.action === "list") {
        const message =
          bindings.length === 0
            ? "No configured credential bindings."
            : `Found ${bindings.length} credential binding(s).`;
        return toolOk(message, {
          details: renderBindingsList(bindings),
          data: { yourAgentId: requestInfo.agentId, bindings },
        });
      }

      if (args.action === "disable") {
        const disabled = args.id ? await disableCredentialBinding(args.id) : null;
        if (!disabled) {
          return toolErr("Credential binding id not found.", {
            data: { yourAgentId: requestInfo.agentId, bindings },
          });
        }

        const nextBindings = await currentBindings();
        return toolOk(`Credential binding ${disabled.configKey} disabled.`, {
          details: renderBindingsList(nextBindings),
          data: { yourAgentId: requestInfo.agentId, bindings: nextBindings },
        });
      }

      if (!args.configKey) {
        return toolErr("configKey is required for upsert.", {
          data: { yourAgentId: requestInfo.agentId, bindings },
        });
      }

      const scope = args.scope ?? "global";
      let scopeId: string | null;
      try {
        scopeId = resolveScopedResourceId(scope, args.scopeId, "bindings");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolErr(message, { data: { yourAgentId: requestInfo.agentId, bindings } });
      }

      if (!args.allowedHosts || (!args.headerTemplate && !args.queryTemplate)) {
        return toolErr(
          "allowedHosts and at least one of headerTemplate or queryTemplate are required for upsert.",
          { data: { yourAgentId: requestInfo.agentId, bindings } },
        );
      }

      if ((args.authKind ?? "config") === "oauth" && !args.oauthAuthorizationId) {
        return toolErr("oauthAuthorizationId is required for oauth bindings.", {
          data: { yourAgentId: requestInfo.agentId, bindings },
        });
      }

      const placeholder = placeholderForConfigKey(args.configKey);
      if (args.headerTemplate && !args.headerTemplate.includes(placeholder)) {
        return toolErr(`headerTemplate must include ${placeholder}.`, {
          data: { yourAgentId: requestInfo.agentId, bindings },
        });
      }
      if (args.queryTemplate && !args.queryTemplate.includes(placeholder)) {
        return toolErr(`queryTemplate must include ${placeholder}.`, {
          data: { yourAgentId: requestInfo.agentId, bindings },
        });
      }

      const nextBinding = CredentialBindingSchema.parse({
        configKey: args.configKey,
        allowedHosts: args.allowedHosts,
        headerTemplate: args.headerTemplate,
        queryTemplate: args.queryTemplate,
        scope,
        scopeId,
        active: true,
        authKind: args.authKind ?? "config",
        oauthAuthorizationId: args.oauthAuthorizationId,
      });

      await upsertCredentialBinding({
        id: args.id,
        configKey: nextBinding.configKey,
        allowedHosts: nextBinding.allowedHosts,
        headerTemplate: nextBinding.headerTemplate,
        queryTemplate: nextBinding.queryTemplate,
        scope: nextBinding.scope,
        scopeId: nextBinding.scopeId ?? null,
        active: true,
        authKind: nextBinding.authKind,
        oauthAuthorizationId: nextBinding.oauthAuthorizationId ?? null,
      });
      const nextBindings = await currentBindings();

      return toolOk(`Credential binding ${args.configKey} saved.`, {
        details: renderBindingsList(nextBindings),
        data: { yourAgentId: requestInfo.agentId, bindings: nextBindings },
      });
    },
  );
};
