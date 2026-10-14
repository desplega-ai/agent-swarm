// Chat SDK adapter fields for the Integrations card.
//
// The API validates `CHAT_SDK_ADAPTERS` with zod schemas in
// `src/integrations/chat-sdk/schema.ts`, which the dashboard cannot import.
// This plain list mirrors those schemas. `src/tests/chat-sdk-fields-sync.test.ts`
// fails when a field name or an enum option drifts from the API side.

export type ChatSdkAdapterName = "telegram" | "slack" | "discord" | "teams";

/**
 * - `secret`: stored as its own secret `swarm_config` row; the JSON carries a
 *   `{ "$config": "<row key>" }` reference.
 * - `list`: a JSON string array, edited as comma-separated text.
 */
export type ChatSdkFieldKind = "secret" | "text" | "select" | "list" | "boolean";

export interface ChatSdkField {
  /** Property name inside the adapter's `CHAT_SDK_ADAPTERS` entry. */
  key: string;
  label: string;
  kind: ChatSdkFieldKind;
  required?: boolean;
  /** Only required while another field of the same adapter has this value. */
  requiredWhen?: { field: string; value: string };
  options?: string[];
  /** One line per select option, shown under the select. */
  optionHints?: Record<string, string>;
  placeholder?: string;
  hint?: string;
}

export interface ChatSdkAdapterDef {
  name: ChatSdkAdapterName;
  label: string;
  /** Set while the adapter has run only against fixtures: the card shows a BETA tag with this text. */
  experimental?: string;
  fields: ChatSdkField[];
}

const EXPERIMENTAL_NOTE =
  "Tested only against fixtures so far, not a real workspace. Setup steps may differ. Progress: github.com/desplega-ai/agent-swarm/issues/2149";

const USER_NAME: ChatSdkField = {
  key: "userName",
  label: "Bot user name",
  kind: "text",
  placeholder: "swarm",
  hint: "Used for mention detection. Leave blank to use the platform's bot name.",
};

export const CHAT_SDK_ADAPTER_DEFS: ChatSdkAdapterDef[] = [
  {
    name: "telegram",
    label: "Telegram",
    fields: [
      {
        key: "botToken",
        label: "Bot token",
        kind: "secret",
        required: true,
        hint: "From BotFather.",
      },
      {
        key: "secretToken",
        label: "Webhook secret token",
        kind: "secret",
        requiredWhen: { field: "mode", value: "webhook" },
        hint: "1 to 256 characters from A-Z, a-z, 0-9, underscore and hyphen. Telegram sends it with every webhook call.",
      },
      {
        key: "mode",
        label: "Mode",
        kind: "select",
        options: ["webhook", "polling"],
        optionHints: {
          webhook:
            "Telegram calls the webhook URL. Needs a public HTTPS URL on port 443, 80, 88 or 8443.",
          polling: "The API asks Telegram for updates. No public URL needed, good for local.",
        },
      },
      {
        key: "allowedUserIds",
        label: "Allowed user IDs",
        kind: "list",
        placeholder: "12345678, 87654321",
        hint: "Only these Telegram users reach the swarm. Leave blank to allow everyone.",
      },
      USER_NAME,
    ],
  },
  {
    name: "slack",
    label: "Slack",
    experimental: EXPERIMENTAL_NOTE,
    fields: [
      {
        key: "botToken",
        label: "Bot token",
        kind: "secret",
        required: true,
        placeholder: "xoxb-...",
      },
      {
        key: "signingSecret",
        label: "Signing secret",
        kind: "secret",
        requiredWhen: { field: "mode", value: "webhook" },
      },
      {
        key: "appToken",
        label: "App token",
        kind: "secret",
        requiredWhen: { field: "mode", value: "socket" },
        placeholder: "xapp-...",
      },
      {
        key: "mode",
        label: "Mode",
        kind: "select",
        options: ["webhook", "socket"],
        optionHints: {
          webhook: "Slack calls the request URL. Needs a public HTTPS URL and the signing secret.",
          socket: "The API connects to Slack. No public URL needed, needs the app token.",
        },
      },
      USER_NAME,
    ],
  },
  {
    name: "discord",
    label: "Discord",
    fields: [
      { key: "botToken", label: "Bot token", kind: "secret", required: true },
      {
        key: "publicKey",
        label: "Public key",
        kind: "text",
        required: true,
        hint: "64 hex characters, from the Developer Portal.",
      },
      { key: "applicationId", label: "Application ID", kind: "text", required: true },
      {
        key: "respondToChannelIds",
        label: "Respond in channel IDs",
        kind: "list",
        hint: "Answer every message in these channels, not only mentions.",
      },
      {
        key: "respondToGlobalMentions",
        label: "Respond to @everyone and @here",
        kind: "boolean",
      },
      { key: "mentionRoleIds", label: "Mention role IDs", kind: "list" },
      USER_NAME,
    ],
  },
  {
    name: "teams",
    label: "Microsoft Teams",
    experimental: EXPERIMENTAL_NOTE,
    fields: [
      { key: "appId", label: "App ID", kind: "text", required: true },
      { key: "appPassword", label: "App password", kind: "secret", required: true },
      {
        key: "appTenantId",
        label: "Tenant ID",
        kind: "text",
        requiredWhen: { field: "appType", value: "SingleTenant" },
      },
      {
        key: "appType",
        label: "App type",
        kind: "select",
        options: ["MultiTenant", "SingleTenant"],
      },
      USER_NAME,
    ],
  },
];

/** The `swarm_config` row a secret field is saved as: `CHAT_SDK_<ADAPTER>_<FIELD>`. */
export function chatSdkSecretKey(adapter: ChatSdkAdapterName, field: string): string {
  const snake = field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return `CHAT_SDK_${adapter.toUpperCase()}_${snake}`;
}
