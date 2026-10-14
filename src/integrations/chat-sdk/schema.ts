import { z } from "zod";

/**
 * `CHAT_SDK_ADAPTERS` schema. Kept free of DB imports because
 * `src/be/swarm-config-guard.ts` (imported by `src/be/db.ts`) validates writes
 * with it; `config.ts` adds the DB-backed resolution on top.
 */

export const CHAT_SDK_ADAPTER_NAMES = ["telegram", "slack", "discord", "teams"] as const;
export type ChatSdkAdapterName = (typeof CHAT_SDK_ADAPTER_NAMES)[number];

export const ConfigRefSchema = z.strictObject({ $config: z.string().min(1) });

/** A literal string or a `{ "$config": "KEY" }` reference to a swarm_config key. */
const Str = z.union([z.string().trim().min(1), ConfigRefSchema]);

/**
 * Keys an operator must never set. A base URL plus a `$config` ref would send
 * the referenced secret to an arbitrary host. A verifier or an "unverified"
 * switch bypasses the platform signature check on the public webhook.
 * Mock base URLs come only from the env-only `CHAT_SDK_API_URL_OVERRIDES`.
 */
const FORBIDDEN_ADAPTER_KEYS = [
  "apiUrl",
  "apiBaseUrl",
  "webhookVerifier",
  "allowUnverifiedWebhooks",
] as const;

function adapterSchema<S extends z.ZodRawShape>(shape: S) {
  return z
    .looseObject({ ...shape, userName: z.string().min(1).optional() })
    .superRefine((value, ctx) => {
      for (const key of FORBIDDEN_ADAPTER_KEYS) {
        if (key in value) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is not allowed in CHAT_SDK_ADAPTERS`,
          });
        }
      }
    });
}

export const TelegramAdapterSchema = adapterSchema({
  botToken: Str,
  secretToken: Str.optional(),
  // Never the SDK's "auto": auto starts long polling against the real Bot API
  // when no webhook is registered.
  mode: z.enum(["webhook", "polling"]).default("webhook"),
  allowedUserIds: z.array(z.union([z.string(), z.number()])).optional(),
});

export const SlackAdapterSchema = adapterSchema({
  botToken: Str,
  signingSecret: Str.optional(),
  appToken: Str.optional(),
  mode: z.enum(["webhook", "socket"]).default("webhook"),
}).superRefine((value, ctx) => {
  // Required here, not left to the adapter: the adapter falls back to
  // SLACK_SIGNING_SECRET / SLACK_APP_TOKEN, which belong to the built-in Slack app.
  if (value.mode === "webhook" && value.signingSecret === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["signingSecret"],
      message: "signingSecret is required in webhook mode",
    });
  }
  if (value.mode === "socket" && value.appToken === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["appToken"],
      message: "appToken is required in socket mode",
    });
  }
});

export const DiscordAdapterSchema = adapterSchema({
  botToken: Str,
  publicKey: Str,
  applicationId: Str,
  respondToChannelIds: z.array(z.string()).optional(),
  respondToGlobalMentions: z.boolean().optional(),
});

export const TeamsAdapterSchema = adapterSchema({
  appId: Str,
  appPassword: Str,
  appTenantId: Str.optional(),
  appType: z.enum(["MultiTenant", "SingleTenant"]).default("MultiTenant"),
}).superRefine((value, ctx) => {
  // The adapter falls back to TEAMS_APP_TENANT_ID when a single-tenant app has no tenant.
  if (value.appType === "SingleTenant" && value.appTenantId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["appTenantId"],
      message: "appTenantId is required for a SingleTenant app",
    });
  }
});

// Strict: a typo'd adapter name must fail loudly, not silently disable it.
export const ChatSdkAdaptersSchema = z
  .strictObject({
    telegram: TelegramAdapterSchema,
    slack: SlackAdapterSchema,
    discord: DiscordAdapterSchema,
    teams: TeamsAdapterSchema,
  })
  .partial();

export type ChatSdkAdapters = z.infer<typeof ChatSdkAdaptersSchema>;

/**
 * `VALIDATED_KEYS` validator for `CHAT_SDK_ADAPTERS`: JSON shape only, no
 * reference resolution. Returns the first issue as a string, or null.
 */
export function validateChatSdkAdaptersValue(value: unknown): string | null {
  if (typeof value !== "string") return "CHAT_SDK_ADAPTERS must be a JSON string";
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    return `CHAT_SDK_ADAPTERS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  const result = ChatSdkAdaptersSchema.safeParse(parsed);
  if (result.success) return null;
  const issue = result.error.issues[0];
  if (!issue) return "CHAT_SDK_ADAPTERS is invalid";
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `CHAT_SDK_ADAPTERS.${path}: ${issue.message}`;
}
