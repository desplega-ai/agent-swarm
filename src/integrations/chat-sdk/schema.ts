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

type AdapterShape = z.ZodRawShape;

function forbiddenKeyIssues(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const key of FORBIDDEN_ADAPTER_KEYS) {
    if (key in value) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is not allowed in CHAT_SDK_ADAPTERS`,
      });
    }
  }
}

/** Fields every adapter has next to its own shape. `enabled: false` keeps the entry but does not start it. */
const COMMON_SHAPE = {
  userName: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
};

function adapterSchema<S extends AdapterShape>(shape: S) {
  return z.looseObject({ ...shape, ...COMMON_SHAPE }).superRefine(forbiddenKeyIssues);
}

/**
 * The same adapter, with every field optional: the shape a dashboard save may
 * store before the operator has every value (`.partial()` refuses schemas with
 * refinements, so the optional shape is built by hand). Forbidden keys and
 * value formats still apply.
 */
function draftShape<S extends AdapterShape>(shape: S): AdapterShape {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [key, (field as z.ZodType).optional()]),
  );
}

const TELEGRAM_SHAPE = {
  botToken: Str,
  secretToken: Str.optional(),
  // Never the SDK's "auto": auto starts long polling against the real Bot API
  // when no webhook is registered.
  mode: z.enum(["webhook", "polling"]).default("webhook"),
  allowedUserIds: z.array(z.union([z.string(), z.number()])).optional(),
};

const SLACK_SHAPE = {
  botToken: Str,
  signingSecret: Str.optional(),
  appToken: Str.optional(),
  mode: z.enum(["webhook", "socket"]).default("webhook"),
};

export const TelegramAdapterSchema = adapterSchema(TELEGRAM_SHAPE);

export const SlackAdapterSchema = adapterSchema(SLACK_SHAPE).superRefine((value, ctx) => {
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

const DISCORD_PUBLIC_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

const DISCORD_SHAPE = {
  botToken: Str,
  publicKey: Str,
  applicationId: Str,
  respondToChannelIds: z.array(z.string()).optional(),
  respondToGlobalMentions: z.boolean().optional(),
  mentionRoleIds: z.array(z.string()).optional(),
};

// A literal key must be the hex Ed25519 public key from the Developer Portal.
// A `$config` value resolves at startup, where the adapter logs a bad format.
function discordPublicKeyIssue(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (typeof value.publicKey === "string" && !DISCORD_PUBLIC_KEY_PATTERN.test(value.publicKey)) {
    ctx.addIssue({
      code: "custom",
      path: ["publicKey"],
      message: "publicKey must be 64 hex characters (the application's Ed25519 public key)",
    });
  }
}

export const DiscordAdapterSchema = adapterSchema(DISCORD_SHAPE).superRefine(discordPublicKeyIssue);

const TEAMS_SHAPE = {
  appId: Str,
  appPassword: Str,
  appTenantId: Str.optional(),
  appType: z.enum(["MultiTenant", "SingleTenant"]).default("MultiTenant"),
};

export const TeamsAdapterSchema = adapterSchema(TEAMS_SHAPE).superRefine((value, ctx) => {
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

/** The full schema of one adapter entry. An entry that fails it is "incomplete". */
export const CHAT_SDK_ADAPTER_SCHEMAS: Record<ChatSdkAdapterName, z.ZodType> = {
  telegram: TelegramAdapterSchema,
  slack: SlackAdapterSchema,
  discord: DiscordAdapterSchema,
  teams: TeamsAdapterSchema,
};

/**
 * What a `CHAT_SDK_ADAPTERS` write must satisfy: known adapter names, object
 * entries, no forbidden keys, well-formed values. Required fields may be
 * missing (a partial dashboard save); such an adapter does not start and the
 * status reports it as incomplete, while the complete adapters run.
 */
export const ChatSdkAdaptersDraftSchema = z
  .strictObject({
    telegram: adapterSchema(draftShape(TELEGRAM_SHAPE)),
    slack: adapterSchema(draftShape(SLACK_SHAPE)),
    discord: adapterSchema(draftShape(DISCORD_SHAPE)).superRefine(discordPublicKeyIssue),
    teams: adapterSchema(draftShape(TEAMS_SHAPE)),
  })
  .partial();

function valueAt(input: unknown, path: PropertyKey[]): unknown {
  let current: unknown = input;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/**
 * `<prefix>.<path>: <message>` for the first issue of a failed parse. With
 * `input`, a missing value reads "required" instead of zod's union text
 * ("Invalid input"), which is what a partial dashboard save produces.
 */
export function firstIssueText(
  error: z.ZodError,
  prefix = "CHAT_SDK_ADAPTERS",
  input?: unknown,
): string {
  const issue = error.issues[0];
  if (!issue) return `${prefix} is invalid`;
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  const missing =
    input !== undefined && issue.path.length > 0 && valueAt(input, issue.path) === undefined;
  return `${prefix}.${path}: ${missing ? "required" : issue.message}`;
}

/**
 * Field names per adapter, derived from the schemas. The dashboard keeps its
 * own field list (`apps/ui/src/lib/chat-sdk-fields.ts`, it cannot import zod
 * schemas from the API); `src/tests/chat-sdk-fields-sync.test.ts` keeps the two equal.
 */
export const CHAT_SDK_ADAPTER_FIELDS: Record<ChatSdkAdapterName, readonly string[]> = {
  telegram: formFields(TelegramAdapterSchema.shape),
  slack: formFields(SlackAdapterSchema.shape),
  discord: formFields(DiscordAdapterSchema.shape),
  teams: formFields(TeamsAdapterSchema.shape),
};

/** `enabled` is the panel switch on the card, not a form field. */
function formFields(shape: AdapterShape): string[] {
  return Object.keys(shape).filter((key) => key !== "enabled");
}

/** True unless the entry carries `enabled: false`. */
export function isAdapterEntryEnabled(entry: Record<string, unknown> | undefined): boolean {
  return entry !== undefined && entry.enabled !== false;
}

/**
 * `VALIDATED_KEYS` validator for `CHAT_SDK_ADAPTERS`: the draft shape only
 * (missing required fields are allowed, see `ChatSdkAdaptersDraftSchema`), no
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
  const result = ChatSdkAdaptersDraftSchema.safeParse(parsed);
  return result.success ? null : firstIssueText(result.error);
}
