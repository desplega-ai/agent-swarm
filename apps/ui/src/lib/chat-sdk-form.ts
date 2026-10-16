// Pure form logic for the Chat SDK Integrations card
// (`components/integrations/chat-sdk-section.tsx`). Secret fields are saved as
// their own secret swarm_config rows (`CHAT_SDK_<ADAPTER>_<FIELD>`); the JSON
// written to `CHAT_SDK_ADAPTERS` carries `{ "$config": "<row key>" }` instead.

import {
  CHAT_SDK_ADAPTER_DEFS,
  type ChatSdkAdapterDef,
  type ChatSdkAdapterName,
  type ChatSdkField,
  chatSdkSecretKey,
} from "./chat-sdk-fields";

export type JsonObject = Record<string, unknown>;
export type AdapterDraft = {
  /** The entry exists in `CHAT_SDK_ADAPTERS` (configured). */
  included: boolean;
  /** The panel switch. Off keeps the entry with `enabled: false`, so the config survives. */
  enabled: boolean;
  values: Record<string, string>;
  secrets: Record<string, string>;
};
export type Drafts = Record<ChatSdkAdapterName, AdapterDraft>;
export type SecretRow = { key: string; value: string };

/** Shown in the JSON preview in place of a plaintext secret value. */
export const MASKED_SECRET = "********";

const DISCORD_PUBLIC_KEY = /^[0-9a-fA-F]{64}$/;

/** Telegram's rule for `setWebhook` `secret_token`. */
const TELEGRAM_SECRET_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

/** Format rules for typed secret values, keyed `<adapter>.<field>`. */
const SECRET_PATTERNS: Record<string, { pattern: RegExp; message: string }> = {
  "telegram.secretToken": {
    pattern: TELEGRAM_SECRET_TOKEN,
    message: "Use 1 to 256 characters from A-Z, a-z, 0-9, underscore and hyphen",
  },
};

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function configRefKey(value: unknown): string | undefined {
  return isObject(value) && typeof value.$config === "string" ? value.$config : undefined;
}

export function parseAdapters(raw: string | undefined): JsonObject {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function storedEntryFor(
  stored: JsonObject,
  name: ChatSdkAdapterName,
): JsonObject | undefined {
  const entry = stored[name];
  return isObject(entry) ? entry : undefined;
}

/**
 * Form text for a stored non-secret value. An object (a `$config` reference
 * written in the Advanced JSON) has no text form: the input starts empty and
 * the object is kept until the user types a replacement.
 */
function toText(field: ChatSdkField, value: unknown): string {
  if (isObject(value)) return "";
  if (value === undefined || value === null)
    return field.kind === "select" ? (field.options?.[0] ?? "") : "";
  if (field.kind === "list" && Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}

export function initialDrafts(stored: JsonObject): Drafts {
  const drafts = {} as Drafts;
  for (const def of CHAT_SDK_ADAPTER_DEFS) {
    const entry = storedEntryFor(stored, def.name);
    const values: Record<string, string> = {};
    for (const field of def.fields) {
      if (field.kind !== "secret") values[field.key] = toText(field, entry?.[field.key]);
    }
    drafts[def.name] = {
      included: entry !== undefined,
      enabled: entry !== undefined && entry.enabled !== false,
      values,
      secrets: {},
    };
  }
  return drafts;
}

/**
 * The stored value of a secret field, or a reference to its own secret row
 * (`CHAT_SDK_<ADAPTER>_<FIELD>`) when the entry has none but the row exists.
 * An adapter switched off and on again keeps its secrets this way: the row
 * survives the switch, only the JSON entry is removed.
 */
export function effectiveSecretValue(
  adapter: ChatSdkAdapterName,
  field: ChatSdkField,
  storedValue: unknown,
  existingKeys: ReadonlySet<string>,
): unknown {
  if (storedValue !== undefined) return storedValue;
  const key = chatSdkSecretKey(adapter, field.key);
  return existingKeys.has(key) ? { $config: key } : undefined;
}

/** The adapter entry the form would save, plus the secret rows it needs. */
export function buildEntry(
  def: ChatSdkAdapterDef,
  draft: AdapterDraft,
  storedEntry: JsonObject | undefined,
  existingKeys: ReadonlySet<string> = new Set(),
): { entry: JsonObject; secretRows: SecretRow[] } {
  // Keys the form does not know (hand-written in the Advanced JSON) are kept.
  const entry: JsonObject = { ...storedEntry };
  // Omitted when on (the default), so an enabled entry stays as it was.
  delete entry.enabled;
  if (!draft.enabled) entry.enabled = false;
  const secretRows: SecretRow[] = [];
  for (const field of def.fields) {
    const storedValue = storedEntry?.[field.key];
    delete entry[field.key];
    if (field.kind === "secret") {
      const typed = draft.secrets[field.key]?.trim();
      const fallback = effectiveSecretValue(def.name, field, storedValue, existingKeys);
      if (typed) {
        const key = chatSdkSecretKey(def.name, field.key);
        secretRows.push({ key, value: typed });
        entry[field.key] = { $config: key };
      } else if (fallback !== undefined) {
        entry[field.key] = fallback;
      }
      continue;
    }
    const text = draft.values[field.key]?.trim() ?? "";
    // An object value stays as stored until the user types a replacement.
    if (!text && isObject(storedValue)) {
      entry[field.key] = storedValue;
      continue;
    }
    if (field.kind === "list") {
      const items = text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (items.length > 0) entry[field.key] = items;
    } else if (field.kind === "boolean") {
      if (text === "true") entry[field.key] = true;
    } else if (text) {
      entry[field.key] = text;
    }
  }
  return { entry, secretRows };
}

export function isRequired(field: ChatSdkField, draft: AdapterDraft): boolean {
  if (field.required) return true;
  return field.requiredWhen
    ? draft.values[field.requiredWhen.field] === field.requiredWhen.value
    : false;
}

/** The format problem of a typed secret value, if any. Empty input has none. */
export function secretFieldProblem(
  adapter: ChatSdkAdapterName,
  field: ChatSdkField,
  typed: string,
): string | undefined {
  const rule = SECRET_PATTERNS[`${adapter}.${field.key}`];
  const value = typed.trim();
  if (!rule || !value) return undefined;
  return rule.pattern.test(value) ? undefined : rule.message;
}

/** Problems that make the API reject the write, or the platform reject a value. */
function adapterProblems(def: ChatSdkAdapterDef, draft: AdapterDraft, entry: JsonObject): string[] {
  const problems: string[] = [];
  for (const field of def.fields) {
    if (field.kind === "secret") {
      const problem = secretFieldProblem(def.name, field, draft.secrets[field.key] ?? "");
      if (problem) problems.push(`${def.label}: ${field.label}: ${problem}`);
    }
  }
  const publicKey = entry.publicKey;
  if (
    def.name === "discord" &&
    typeof publicKey === "string" &&
    !DISCORD_PUBLIC_KEY.test(publicKey)
  ) {
    problems.push("Discord: Public key must be 64 hex characters");
  }
  return problems;
}

/**
 * Required fields the entry lacks. A save still goes through: the API stores
 * the entry, reports the adapter as incomplete and starts the other adapters.
 */
function missingFields(def: ChatSdkAdapterDef, draft: AdapterDraft, entry: JsonObject): string[] {
  return def.fields
    .filter((field) => isRequired(field, draft) && entry[field.key] === undefined)
    .map((field) => `${def.label}: ${field.label}`);
}

export interface BuiltAdapters {
  adapters: JsonObject;
  secretRows: SecretRow[];
  /** Block the save. */
  problems: string[];
  /** Allowed to save; the adapter stays off until these are filled in. */
  missing: string[];
}

export function buildAll(
  drafts: Drafts,
  stored: JsonObject,
  /** Global config keys that exist: secret rows of a switched-off adapter are reused. */
  existingKeys: ReadonlySet<string> = new Set(),
): BuiltAdapters {
  const adapters: JsonObject = {};
  const secretRows: SecretRow[] = [];
  const problems: string[] = [];
  const missing: string[] = [];
  for (const def of CHAT_SDK_ADAPTER_DEFS) {
    const draft = drafts[def.name];
    if (!draft.included) continue;
    const result = buildEntry(def, draft, storedEntryFor(stored, def.name), existingKeys);
    adapters[def.name] = result.entry;
    secretRows.push(...result.secretRows);
    problems.push(...adapterProblems(def, draft, result.entry));
    missing.push(...missingFields(def, draft, result.entry));
  }
  return { adapters, secretRows, problems, missing };
}

/**
 * The adapters object to write, merged over the value stored right now.
 * The form was built from `stored`; another tab, an API call or a lead may
 * have changed the row since. Only adapters this form touched (switch
 * flipped, a value or a secret typed) take the form's version; every other
 * adapter keeps what the row holds now. Without this, a stale form that never
 * saw a newly added adapter removed it on save.
 */
export function mergeAdaptersForSave(
  fresh: JsonObject,
  stored: JsonObject,
  drafts: Drafts,
  builtAdapters: JsonObject,
): JsonObject {
  const baseline = initialDrafts(stored);
  const next: JsonObject = { ...fresh };
  for (const def of CHAT_SDK_ADAPTER_DEFS) {
    const draft = drafts[def.name];
    const touched = JSON.stringify(draft) !== JSON.stringify(baseline[def.name]);
    if (!touched) continue;
    if (draft.included) next[def.name] = builtAdapters[def.name];
    else delete next[def.name];
  }
  return next;
}

/**
 * Bot permissions for the Discord invite link: View Channels, Send Messages,
 * Send Messages in Threads, Create Public Threads, Manage Threads, Read Message
 * History, Add Reactions, Attach Files, Embed Links. The adapter README lists
 * the same set (minus View Channels and Embed Links, which the bot needs to see
 * a channel and to render link previews).
 */
export const DISCORD_INVITE_PERMISSIONS = "326417632320";

/** The OAuth2 invite URL for the application, or undefined without an id. */
export function discordInviteUrl(applicationId: string | undefined): string | undefined {
  const id = applicationId?.trim();
  if (!id || !/^\d{15,25}$/.test(id)) return undefined;
  const params = new URLSearchParams({
    client_id: id,
    scope: "bot applications.commands",
    permissions: DISCORD_INVITE_PERMISSIONS,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/**
 * The adapters object for the on-screen preview: a secret field that holds a
 * plain string (not a `$config` reference) shows as `MASKED_SECRET`. The saved
 * JSON keeps the real value.
 */
export function maskSecretsForPreview(adapters: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [name, value] of Object.entries(adapters)) {
    const def = CHAT_SDK_ADAPTER_DEFS.find((candidate) => candidate.name === name);
    if (!def || !isObject(value)) {
      out[name] = value;
      continue;
    }
    const entry: JsonObject = { ...value };
    for (const field of def.fields) {
      if (field.kind === "secret" && typeof entry[field.key] === "string") {
        entry[field.key] = MASKED_SECRET;
      }
    }
    out[name] = entry;
  }
  return out;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The port to expose with a tunnel when `webhookUrl` points at this machine
 * (localhost, 127.0.0.1 or [::1]). Undefined for a public host or a value
 * that is not a URL.
 */
export function localTunnelPort(webhookUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return undefined;
  }
  if (!LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())) return undefined;
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}
