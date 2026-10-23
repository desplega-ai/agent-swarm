/**
 * HITL `config` questions: ask a person to set one swarm config key (a secret
 * or a plain value) from the dashboard. The answer is written to
 * `swarm_config` by the respond handler, and only a {@link ConfigResult} is
 * ever stored on the request or sent onward, so a secret never reaches the
 * agent, the workflow run, the follow-up task or any notification.
 */
import * as z from "zod";
import { getDbClient } from "./db";
import { upsertSwarmConfigWithPolicyMirror } from "./multi-runtime";
import {
  internalConfigKeyError,
  isApiOnlyConfigKey,
  isInternalConfigKey,
  isReservedConfigKey,
  reservedKeyError,
  validateConfigEntry,
} from "./swarm-config-guard";

export const ConfigQuestionSettingsSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(255)
    .regex(/^\S+$/, "must not contain whitespace")
    .describe("The swarm config key to set, e.g. BITBUCKET_TOKEN"),
  scope: z.enum(["global", "agent", "repo"]).describe("Config scope the value is written to"),
  scopeId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Agent or repo id for agent/repo scope. From request-human-input, agent scope defaults to the calling agent; pass it explicitly when asking on behalf of another agent.",
    ),
  isSecret: z
    .boolean()
    .optional()
    .describe(
      "Store encrypted and never show the value (default true). An existing secret row always stays secret.",
    ),
  helpUrl: z
    .string()
    .url()
    .refine((url) => /^https?:\/\//i.test(url), "must be an http(s) URL")
    .optional()
    .describe("Link shown next to the field, e.g. where to create the token"),
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional()
    .describe("Allowed values for a non-secret key, rendered as a choice"),
  defaultValue: z.string().optional().describe("Prefilled value for a non-secret key"),
});

export type ConfigQuestionSettings = z.infer<typeof ConfigQuestionSettingsSchema>;

/** Settings after create-time normalization: `isSecret` is always resolved. */
export type NormalizedConfigSettings = ConfigQuestionSettings & { isSecret: boolean };

/** What the dashboard sends for a config question (D6). */
export const ConfigAnswerSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), value: z.string() }),
  z.object({ action: z.literal("keep") }),
  z.object({ action: z.literal("skip") }),
]);
export type ConfigAnswer = z.infer<typeof ConfigAnswerSchema>;

/** The only form of a config answer that is ever stored or sent (D7). */
export const ConfigResultSchema = z.object({
  key: z.string(),
  scope: z.enum(["global", "agent", "repo"]),
  scopeId: z.string().nullable(),
  isSecret: z.boolean(),
  status: z.enum(["set", "kept", "skipped"]),
  updatedAt: z.string().nullable(),
  value: z.string().optional(),
});
export type ConfigResult = z.infer<typeof ConfigResultSchema>;

/** Live state of the key a config question targets (never persisted). */
export const ConfigStateSchema = z.object({
  exists: z.boolean(),
  isSecret: z.boolean(),
  updatedAt: z.string().nullable(),
  value: z.string().optional().describe("Current value; present only for non-secret rows"),
});
export type ConfigState = z.infer<typeof ConfigStateSchema>;

type ConfigQuestionInput = {
  id: string;
  type: string;
  label?: string;
  required?: boolean;
  config?: ConfigQuestionSettings;
};

export type NormalizedConfigQuestion<Q extends ConfigQuestionInput> = Omit<Q, "config"> & {
  label: string;
  required: boolean;
  config: NormalizedConfigSettings;
};

type ApproversLike = { policy: unknown };

interface ConfigRowMeta {
  isSecret: boolean;
  updatedAt: string;
  envPath: string | null;
  description: string | null;
  value?: string;
}

/** The exact `(scope, scopeId, key)` row, without decrypting anything. */
async function readConfigRow(
  settings: Pick<ConfigQuestionSettings, "scope" | "scopeId" | "key">,
): Promise<ConfigRowMeta | null> {
  const scopeId = settings.scope === "global" ? null : (settings.scopeId ?? null);
  const row = await getDbClient().get<{
    isSecret: number;
    lastUpdatedAt: string;
    envPath: string | null;
    description: string | null;
    plainValue: string | null;
  }>(
    `SELECT isSecret, lastUpdatedAt, envPath, description,
            CASE WHEN isSecret = 1 THEN NULL ELSE value END AS plainValue
       FROM swarm_config
      WHERE scope = ? AND ${scopeId === null ? "scopeId IS NULL" : "scopeId = ?"} AND key = ?`,
    scopeId === null ? [settings.scope, settings.key] : [settings.scope, scopeId, settings.key],
  );
  if (!row) return null;
  // API-only keys are never readable over HTTP, so they count as secret here.
  const isSecret = row.isSecret === 1 || isApiOnlyConfigKey(settings.key);
  return {
    isSecret,
    updatedAt: row.lastUpdatedAt,
    envPath: row.envPath,
    description: row.description,
    ...(isSecret || row.plainValue === null ? {} : { value: row.plainValue }),
  };
}

export async function readConfigState(settings: ConfigQuestionSettings): Promise<ConfigState> {
  const row = await readConfigRow(settings);
  if (!row) return { exists: false, isSecret: settings.isSecret !== false, updatedAt: null };
  const isSecret = row.isSecret || settings.isSecret !== false;
  return {
    exists: true,
    isSecret,
    updatedAt: row.updatedAt,
    ...(!isSecret && row.value !== undefined ? { value: row.value } : {}),
  };
}

/**
 * Create-time rules for one config question (D2, D3, D5). Defaults `label` to
 * the key and `required` to true, resolves the effective `isSecret` against
 * the live row, and rejects keys and shapes the config API would refuse.
 */
export async function normalizeConfigQuestion<Q extends ConfigQuestionInput>(
  question: Q,
  ctx: { approvers: ApproversLike; callerAgentId?: string },
): Promise<{ ok: true; question: NormalizedConfigQuestion<Q> } | { ok: false; error: string }> {
  const fail = (reason: string) => ({
    ok: false as const,
    error: `config question "${question.id}": ${reason}`,
  });
  const parsed = ConfigQuestionSettingsSchema.safeParse(question.config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `config.${issue.path.map(String).join(".")}` : "config";
    return fail(`${path}: ${issue?.message ?? "invalid"}`);
  }
  if (ctx.approvers.policy !== "any") {
    return fail('a config question needs approvers.policy "any" (a config value has one author)');
  }

  const settings = { ...parsed.data };
  if (settings.scope === "agent" && !settings.scopeId && ctx.callerAgentId) {
    settings.scopeId = ctx.callerAgentId;
  }
  if (settings.scope === "global" && settings.scopeId) {
    return fail("global scope must not have scopeId");
  }
  if (settings.scope !== "global" && !settings.scopeId) {
    return fail(`${settings.scope} scope requires scopeId`);
  }
  if (isReservedConfigKey(settings.key)) return fail(reservedKeyError(settings.key).message);
  if (isInternalConfigKey(settings.key)) return fail(internalConfigKeyError(settings.key).message);

  const row = await readConfigRow(settings);
  const isSecret =
    settings.isSecret !== false || row?.isSecret === true || isApiOnlyConfigKey(settings.key);
  if (isSecret && (settings.options || settings.defaultValue !== undefined)) {
    return fail(
      "options and defaultValue are only allowed when isSecret is false (and the key is not already stored as a secret)",
    );
  }
  if (settings.options?.length === 0) return fail("options must not be empty");
  if (
    settings.options &&
    settings.defaultValue !== undefined &&
    !settings.options.some((option) => option.value === settings.defaultValue)
  ) {
    return fail("defaultValue must be one of options");
  }

  const label = question.label?.trim() ? question.label : settings.key;
  return {
    ok: true,
    question: {
      ...question,
      label,
      required: question.required ?? true,
      config: { ...settings, isSecret },
    },
  };
}

type AnyQuestion = { id: string; type: string; label?: string; config?: ConfigQuestionSettings };

/**
 * Normalizes every config question in a list and checks that the others carry
 * a label and no `config` block. Non-config questions pass through unchanged.
 */
export async function normalizeApprovalQuestions<Q extends AnyQuestion>(
  questions: Q[],
  ctx: { approvers: ApproversLike; callerAgentId?: string },
): Promise<
  | { ok: true; questions: ((Q & { label: string }) | NormalizedConfigQuestion<Q>)[] }
  | { ok: false; error: string }
> {
  const out: ((Q & { label: string }) | NormalizedConfigQuestion<Q>)[] = [];
  for (const question of questions) {
    if (question.type !== "config") {
      if (question.config !== undefined) {
        return {
          ok: false,
          error: `question "${question.id}": the config block is only valid on type "config"`,
        };
      }
      if (typeof question.label !== "string") {
        return { ok: false, error: `question "${question.id}": label is required` };
      }
      out.push({ ...question, label: question.label });
      continue;
    }
    const normalized = await normalizeConfigQuestion(question, ctx);
    if (!normalized.ok) return normalized;
    out.push(normalized.question);
  }
  return { ok: true, questions: out };
}

/** A stored config question, as read back from `approval_requests.questions`. */
export type StoredConfigQuestion = {
  id: string;
  type: "config";
  label: string;
  required?: boolean;
  config: NormalizedConfigSettings;
};

export function isConfigQuestion(question: {
  type: string;
  config?: unknown;
}): question is StoredConfigQuestion {
  return question.type === "config" && typeof question.config === "object" && !!question.config;
}

/**
 * Validates one raw answer against D6 and the config API's rules. Errors name
 * the question and the rule, never the value.
 */
export function parseConfigAnswer(
  question: StoredConfigQuestion,
  raw: unknown,
  state: ConfigState,
): { ok: true; answer: ConfigAnswer } | { ok: false; error: string } {
  const fail = (reason: string) => ({
    ok: false as const,
    error: `config question "${question.id}": ${reason}`,
  });
  const required = question.required !== false;
  if (raw === undefined || raw === null) {
    return required ? fail("an answer is required") : { ok: true, answer: { action: "skip" } };
  }
  const parsed = ConfigAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      'answer must be { action: "set", value } , { action: "keep" } or { action: "skip" }',
    );
  }
  const answer = parsed.data;
  if (answer.action === "keep") {
    return state.exists ? { ok: true, answer } : fail("cannot keep a key that is not set");
  }
  if (answer.action === "skip") {
    return required ? fail("a required question cannot be skipped") : { ok: true, answer };
  }
  if (answer.value.trim().length === 0) return fail("value must not be empty");
  const { config } = question;
  const isSecret = config.isSecret || state.isSecret;
  if (!isSecret && config.options && !config.options.some((o) => o.value === answer.value)) {
    return fail("value must be one of options");
  }
  const error = validateConfigEntry({
    scope: config.scope,
    scopeId: config.scopeId ?? null,
    key: config.key,
    value: answer.value,
  });
  if (error) return fail(isSecret ? `value rejected by ${config.key} validation` : error);
  return { ok: true, answer };
}

function result(
  question: StoredConfigQuestion,
  status: ConfigResult["status"],
  isSecret: boolean,
  updatedAt: string | null,
  value?: string,
): ConfigResult {
  const { key, scope, scopeId } = question.config;
  return {
    key,
    scope,
    scopeId: scope === "global" ? null : (scopeId ?? null),
    isSecret,
    status,
    updatedAt,
    ...(!isSecret && value !== undefined ? { value } : {}),
  };
}

export function skippedConfigResult(question: StoredConfigQuestion): ConfigResult {
  return result(question, "skipped", question.config.isSecret, null);
}

/** `keep`: nothing is written. Null when the row disappeared since validation. */
export async function keptConfigResult(
  question: StoredConfigQuestion,
): Promise<ConfigResult | null> {
  const row = await readConfigRow(question.config);
  if (!row) return null;
  const isSecret = question.config.isSecret || row.isSecret;
  return result(question, "kept", isSecret, row.updatedAt, row.value);
}

/**
 * `set`: writes the value inside the caller's transaction. Carries the row's
 * `envPath` and `description` forward (the upsert would null them) and keeps
 * an existing secret secret. The caller runs the HTTP side effects after
 * commit.
 */
export async function applyConfigAnswer(
  question: StoredConfigQuestion,
  value: string,
): Promise<ConfigResult> {
  const { config } = question;
  const existing = await readConfigRow(config);
  const isSecret = config.isSecret || existing?.isSecret === true;
  const written = await upsertSwarmConfigWithPolicyMirror({
    scope: config.scope,
    scopeId: config.scope === "global" ? null : (config.scopeId ?? null),
    key: config.key,
    value,
    isSecret,
    envPath: existing?.envPath ?? null,
    description: existing?.description ?? null,
  });
  return result(question, "set", isSecret, written.lastUpdatedAt, value);
}

/** One line for the hitl-follow-up task text. Never carries a secret. */
export function formatConfigResult(value: unknown): string | null {
  const parsed = ConfigResultSchema.safeParse(value);
  if (!parsed.success) return null;
  const r = parsed.data;
  const where = `${r.scope}${r.scopeId ? `:${r.scopeId}` : ""}`;
  const updated = r.updatedAt ? `, updated ${r.updatedAt}` : "";
  const shown = !r.isSecret && r.value !== undefined ? ` = ${r.value}` : "";
  return `${r.key} (${where}, ${r.isSecret ? "secret" : "plain"}): ${r.status}${updated}${shown}`;
}
