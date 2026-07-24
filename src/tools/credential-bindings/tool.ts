import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import {
  getOAuthAppIdByProvider,
  listAuthorizationsForApp,
  upsertOAuthApp,
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
import { createToolRegistrar } from "@/tools/utils";
import { getPublicMcpBaseUrl } from "@/utils/constants";
import { resolveScopedResourceId, scopedResourceScopeIdSchema } from "@/utils/scoped-resource";

const providerSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_-]+$/);
const tokenStatusSchema = z.enum(["ok", "expiring", "refresh-failed", "revoked", "missing"]);
const credentialBindingToolBindingSchema = CredentialBindingSchema.and(
  z.object({
    id: z.string().optional(),
    source: z.enum(["default", "user", "migration"]).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    createdBy: z.string().nullable().optional(),
    updatedBy: z.string().nullable().optional(),
    tokenStatus: tokenStatusSchema.optional(),
  }),
);

const credentialBindingsOutputSchema = z.object({
  yourAgentId: z.string().uuid().optional(),
  success: z.boolean(),
  message: z.string(),
  provider: z.string().optional(),
  authorizeUrl: z.string().optional(),
  redirectUri: z.string().optional(),
  state: z.string().optional(),
  label: z.string().optional(),
  authorizations: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        accountEmail: z.string().nullable(),
        status: z.string(),
        expiresAt: z.string().nullable(),
        scope: z.string().nullable(),
      }),
    )
    .optional(),
  setupHints: z.array(z.string()).optional(),
  bindings: z.array(credentialBindingToolBindingSchema),
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

function decorateBindings(bindings: ScriptCredentialBindingRecord[]): BindingWithTokenStatus[] {
  return bindings.map((binding) =>
    binding.authKind === "oauth"
      ? {
          ...binding,
          tokenStatus: binding.oauthAuthorizationId
            ? getOAuthBindingTokenStatus(binding.oauthAuthorizationId)
            : "missing",
        }
      : binding,
  );
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
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
            bindings: [],
          },
        };
      }

      const agent = getAgentById(requestInfo.agentId);
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
        return {
          content: [{ type: "text", text: denyMessage }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: denyMessage,
            bindings: [],
          },
        };
      }

      const currentBindings = () =>
        decorateBindings(
          listRelationalCredentialBindings({ includeInactive: true, excludeManaged: true }),
        );
      const bindings = currentBindings();

      if (args.action === "oauth-app-upsert") {
        // A presetId fills endpoints/scopes/quirks; explicit fields still win.
        const preset = args.presetId ? getOAuthPreset(args.presetId) : null;
        if (args.presetId && !preset) {
          const message = `Unknown presetId "${args.presetId}". Valid preset ids: ${listOAuthPresetIds().join(", ")}.`;
          return {
            content: [{ type: "text", text: message }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message,
              bindings,
            },
          };
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
          return {
            content: [{ type: "text", text: message }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message,
              bindings,
            },
          };
        }

        try {
          assertOAuthAppUrlsSafe({ authorizeUrl, tokenUrl, userinfoUrl, revocationUrl });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: message }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message,
              bindings,
            },
          };
        }

        const extraParams = hydrated?.extraParams ?? args.extraParams;
        const tokenAuthStyle = hydrated?.tokenAuthStyle ?? args.tokenAuthStyle;
        const tokenBodyFormat = hydrated?.tokenBodyFormat ?? args.tokenBodyFormat;

        const redirectUri = staticOAuthCallbackUri();
        upsertOAuthApp(provider, {
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

        const hintText =
          hydrated && hydrated.setupHints.length > 0
            ? `\nSetup hints:\n${hydrated.setupHints.map((hint) => `- ${hint}`).join("\n")}`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `OAuth app ${provider} saved. Redirect URI: ${redirectUri}${hintText}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `OAuth app ${provider} saved.`,
            provider,
            redirectUri,
            ...(hydrated ? { setupHints: hydrated.setupHints } : {}),
            bindings: currentBindings(),
          },
        };
      }

      if (args.action === "oauth-authorize-url") {
        if (!args.provider) {
          return {
            content: [{ type: "text", text: "provider is required for oauth-authorize-url." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "provider is required for oauth-authorize-url.",
              bindings,
            },
          };
        }

        const config = getOAuthProviderConfig(args.provider);
        if (!config) {
          return {
            content: [{ type: "text", text: `OAuth app ${args.provider} is not configured.` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `OAuth app ${args.provider} is not configured.`,
              provider: args.provider,
              bindings,
            },
          };
        }

        const label = args.label ?? "default";
        const result = await buildAuthorizationUrl(
          { ...config, redirectUri: staticOAuthCallbackUri() },
          { label },
        );
        return {
          content: [{ type: "text", text: result.url }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `OAuth authorization URL generated for ${args.provider} ("${label}").`,
            provider: args.provider,
            authorizeUrl: result.url,
            redirectUri: staticOAuthCallbackUri(),
            state: result.state,
            label,
            bindings,
          },
        };
      }

      if (args.action === "oauth-authorizations-list") {
        if (!args.provider) {
          return {
            content: [
              { type: "text", text: "provider is required for oauth-authorizations-list." },
            ],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "provider is required for oauth-authorizations-list.",
              bindings,
            },
          };
        }
        const appId = getOAuthAppIdByProvider(args.provider);
        if (!appId) {
          return {
            content: [{ type: "text", text: `OAuth app ${args.provider} is not configured.` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `OAuth app ${args.provider} is not configured.`,
              provider: args.provider,
              bindings,
            },
          };
        }
        const authorizations = listAuthorizationsForApp(appId).map((authorization) => ({
          id: authorization.id,
          label: authorization.label,
          accountEmail: authorization.accountEmail,
          status: authorization.status,
          expiresAt: authorization.expiresAt,
          scope: authorization.scope,
        }));
        return {
          content: [
            {
              type: "text",
              text: `Found ${authorizations.length} authorization(s) for ${args.provider}.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Found ${authorizations.length} authorization(s) for ${args.provider}.`,
            provider: args.provider,
            authorizations,
            bindings,
          },
        };
      }

      if (args.action === "list") {
        return {
          content: [
            {
              type: "text",
              text:
                bindings.length === 0
                  ? "No configured credential bindings."
                  : `Found ${bindings.length} credential binding(s).`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message:
              bindings.length === 0
                ? "No configured credential bindings."
                : `Found ${bindings.length} credential binding(s).`,
            bindings,
          },
        };
      }

      if (args.action === "disable") {
        const disabled = args.id ? disableCredentialBinding(args.id) : null;
        if (!disabled) {
          return {
            content: [{ type: "text", text: "Credential binding id not found." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Credential binding id not found.",
              bindings,
            },
          };
        }

        const nextBindings = currentBindings();
        return {
          content: [{ type: "text", text: `Credential binding ${disabled.configKey} disabled.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Credential binding ${disabled.configKey} disabled.`,
            bindings: nextBindings,
          },
        };
      }

      if (!args.configKey) {
        return {
          content: [{ type: "text", text: "configKey is required for upsert." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "configKey is required for upsert.",
            bindings,
          },
        };
      }

      const scope = args.scope ?? "global";
      let scopeId: string | null;
      try {
        scopeId = resolveScopedResourceId(scope, args.scopeId, "bindings");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: message }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message,
            bindings,
          },
        };
      }

      if (!args.allowedHosts || (!args.headerTemplate && !args.queryTemplate)) {
        return {
          content: [
            {
              type: "text",
              text: "allowedHosts and at least one of headerTemplate or queryTemplate are required for upsert.",
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message:
              "allowedHosts and at least one of headerTemplate or queryTemplate are required for upsert.",
            bindings,
          },
        };
      }

      if ((args.authKind ?? "config") === "oauth" && !args.oauthAuthorizationId) {
        return {
          content: [{ type: "text", text: "oauthAuthorizationId is required for oauth bindings." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "oauthAuthorizationId is required for oauth bindings.",
            bindings,
          },
        };
      }

      const placeholder = placeholderForConfigKey(args.configKey);
      if (args.headerTemplate && !args.headerTemplate.includes(placeholder)) {
        return {
          content: [{ type: "text", text: `headerTemplate must include ${placeholder}.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `headerTemplate must include ${placeholder}.`,
            bindings,
          },
        };
      }
      if (args.queryTemplate && !args.queryTemplate.includes(placeholder)) {
        return {
          content: [{ type: "text", text: `queryTemplate must include ${placeholder}.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `queryTemplate must include ${placeholder}.`,
            bindings,
          },
        };
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

      upsertCredentialBinding({
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
      const nextBindings = currentBindings();

      return {
        content: [{ type: "text", text: `Credential binding ${args.configKey} saved.` }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success: true,
          message: `Credential binding ${args.configKey} saved.`,
          bindings: nextBindings,
        },
      };
    },
  );
};
