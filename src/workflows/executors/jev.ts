import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorReadinessNode,
  type ExecutorReadinessProblem,
  type ExecutorResult,
} from "./base";
import {
  JEV_DEFAULT_PROVIDER,
  JEV_PROVIDER_IDS,
  JEV_PROVIDERS,
  type JevProvider,
  type JevProviderId,
  jevKeyRejectedMessage,
  jevProviderOf,
  resolveJevCredential,
} from "./jev-providers";

// ─── Constants ──────────────────────────────────────────────

export const JEV_NODE_TYPE = "jev";

/**
 * The TypeSafe host and its credential name, kept as named exports. The set of
 * hosts a node may reach is `JEV_PROVIDERS`: no endpoint, header, or key field
 * exists in a definition, only `provider`, an id from that list.
 */
export const JEV_ENDPOINT = JEV_PROVIDERS.typesafe.endpoint;
export const JEV_API_KEY_CONFIG_KEY = JEV_PROVIDERS.typesafe.keyName;

export const JEV_DEFAULT_TIMEOUT_MS = 30_000;
export const JEV_MIN_TIMEOUT_MS = 1_000;
export const JEV_MAX_TIMEOUT_MS = 300_000;
export const JEV_DEFAULT_MAX_RETRIES = 2;
export const JEV_MAX_RETRIES_LIMIT = 3;

/** Choice: 2-255 options, Score: 2-10 levels (TypeSafe primitive limits; 2 is our authoring floor). */
const CHOICE_MIN_OPTIONS = 2;
const CHOICE_MAX_OPTIONS = 255;
const SCORE_MIN_LEVELS = 2;
const SCORE_MAX_LEVELS = 10;

/** Room left before the engine watchdog fires so the executor can report its own failure. */
const DEADLINE_MARGIN_MS = 250;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
/** A returned distribution must sum to 1 within this tolerance. It is checked, never normalized. */
const DISTRIBUTION_TOLERANCE = 0.02;
const MAX_RESPONSE_CHARS = 1_048_576;
const MAX_ERROR_BODY_CHARS = 65_536;

/** Engine-level retries default to 3 when a stored policy omits the count. */
const ENGINE_RETRY_DEFAULT = 3;

// ─── Config schema ──────────────────────────────────────────

/** A description slot: string, JSON object, JSON array, or null (TypeSafe "advanced structure"). */
const JevEntrySchema = z.union([
  z.string(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const JevInstructionsSchema = JevEntrySchema.refine(
  (value) => value !== null && !(typeof value === "string" && value.trim() === ""),
  { message: "instructions must not be null or blank" },
);

const JevStateSchema = z.union([
  z.string().min(1, "state must not be empty"),
  z.array(z.string()).min(1, "state must not be an empty array"),
  z.record(z.string(), z.unknown()),
]);

const NoulQuestionSchema = z.strictObject({
  type: z.literal("noul"),
  instructions: JevInstructionsSchema,
  criteria: z
    .strictObject({ true: JevEntrySchema.optional(), false: JevEntrySchema.optional() })
    .refine((criteria) => criteria.true !== undefined || criteria.false !== undefined, {
      message: "noul criteria must describe at least one of true / false",
    })
    .optional(),
});

const ChoiceQuestionSchema = z.strictObject({
  type: z.literal("choice"),
  instructions: JevInstructionsSchema,
  criteria: z.record(z.string().min(1), JevEntrySchema).refine(
    (criteria) => {
      const count = Object.keys(criteria).length;
      return count >= CHOICE_MIN_OPTIONS && count <= CHOICE_MAX_OPTIONS;
    },
    {
      message: `choice criteria must define ${CHOICE_MIN_OPTIONS}-${CHOICE_MAX_OPTIONS} options`,
    },
  ),
});

const ScoreQuestionSchema = z.strictObject({
  type: z.literal("score"),
  instructions: JevInstructionsSchema,
  criteria: z.array(JevEntrySchema).min(SCORE_MIN_LEVELS).max(SCORE_MAX_LEVELS),
});

export const JevQuestionSchema = z.discriminatedUnion("type", [
  NoulQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
]);

const QUESTION_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED_QUESTION_IDS = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);

const JevPrimitiveTypeSchema = z.enum(["noul", "choice", "score"]);

export const JevConfigSchema = z
  .strictObject({
    provider: z.enum(JEV_PROVIDER_IDS).default(JEV_DEFAULT_PROVIDER),
    /** Provider-specific model id. Unset means the provider's default. */
    model: z.string().min(1).optional(),
    state: JevStateSchema,
    timeoutMs: z
      .number()
      .int()
      .min(JEV_MIN_TIMEOUT_MS)
      .max(JEV_MAX_TIMEOUT_MS)
      .default(JEV_DEFAULT_TIMEOUT_MS),
    maxRetries: z.number().int().min(0).max(JEV_MAX_RETRIES_LIMIT).default(JEV_DEFAULT_MAX_RETRIES),
    questions: z.record(
      z
        .string()
        .regex(
          QUESTION_ID_RE,
          "question ids must start with a letter or underscore and use only letters, digits, _ or -",
        ),
      JevQuestionSchema,
    ),
    returns: z.record(z.string(), z.strictObject({ type: JevPrimitiveTypeSchema })),
  })
  .superRefine((config, ctx) => {
    const questionIds = Object.keys(config.questions);
    if (questionIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: "jev needs at least one question",
      });
    }
    for (const id of questionIds) {
      if (RESERVED_QUESTION_IDS.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", id],
          message: `"${id}" is reserved and cannot be a question id`,
        });
      }
      const declared = Object.hasOwn(config.returns, id) ? config.returns[id] : undefined;
      if (!declared) {
        ctx.addIssue({
          code: "custom",
          path: ["returns"],
          message: `returns must declare question "${id}"`,
        });
      } else if (declared.type !== config.questions[id]?.type) {
        ctx.addIssue({
          code: "custom",
          path: ["returns", id, "type"],
          message: `returns.${id}.type is "${declared.type}" but question "${id}" is "${config.questions[id]?.type}"`,
        });
      }
    }
    for (const id of Object.keys(config.returns)) {
      if (!Object.hasOwn(config.questions, id)) {
        ctx.addIssue({
          code: "custom",
          path: ["returns", id],
          message: `returns declares "${id}" but no question has that id`,
        });
      }
    }
  });

export type JevConfig = z.infer<typeof JevConfigSchema>;
export type JevQuestion = z.infer<typeof JevQuestionSchema>;

// ─── Output schema ──────────────────────────────────────────

const Unit = z.number().min(0).max(1);

const NoulAnswerSchema = z.strictObject({ type: z.literal("noul"), noul: Unit });

const ChoiceAnswerSchema = z.strictObject({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), Unit),
  confidence: Unit,
});

const ScoreAnswerSchema = z.strictObject({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(z.string(), JevEntrySchema),
  probabilities: z.record(z.string(), Unit),
  confidence: Unit,
});

const JevAnswerSchema = z.discriminatedUnion("type", [
  NoulAnswerSchema,
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
]);

export const JevOutputSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), JevAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }),
  requestId: z.string().optional(),
});

export type JevAnswer = z.infer<typeof JevAnswerSchema>;
export type JevOutput = z.infer<typeof JevOutputSchema>;

// ─── Engine-facing rules (authoring + runtime) ──────────────

interface RetryShape {
  maxRetries?: number;
}

/**
 * Why a `jev` node may not carry an engine retry policy.
 *
 * The executor owns its transient retries (`config.maxRetries`). Engine retries
 * are not status-aware, so a node-level or validation retry would re-send 401 / 422
 * requests and multiply the attempt count. Returns one message per violation.
 */
export function jevRetryViolations(node: {
  id: string;
  type: string;
  retry?: RetryShape | null;
  validation?: { retry?: RetryShape | null } | null;
}): string[] {
  if (node.type !== JEV_NODE_TYPE) return [];
  const violations: string[] = [];
  const attempts = (retry: RetryShape | null | undefined) =>
    retry ? (retry.maxRetries ?? ENGINE_RETRY_DEFAULT) : 0;
  if (attempts(node.retry) > 0) {
    violations.push(
      `Node "${node.id}" (jev) must not set retry.maxRetries > 0: the jev executor retries transient transport errors itself (config.maxRetries), and engine retries would re-send rejected requests`,
    );
  }
  if (attempts(node.validation?.retry) > 0) {
    violations.push(
      `Node "${node.id}" (jev) must not set validation.retry.maxRetries > 0: a validation-driven retry would send another paid request`,
    );
  }
  return violations;
}

/** Static-shape rules that a per-field schema cannot express (question ids, return types, and the provider are static). */
export function jevStaticShapeViolations(node: {
  id: string;
  type: string;
  config: Record<string, unknown>;
}): string[] {
  if (node.type !== JEV_NODE_TYPE) return [];
  const violations: string[] = [];
  for (const field of ["questions", "returns"] as const) {
    const value = node.config[field];
    if (
      value !== undefined &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      violations.push(
        `Node "${node.id}" (jev) config.${field} must be an object: question ids and return types are static, only state and descriptions may use {{tokens}}`,
      );
    }
  }
  const provider = node.config.provider;
  if (typeof provider === "string" && provider.includes("{{")) {
    violations.push(
      `Node "${node.id}" (jev) config.provider must be a literal (${JEV_PROVIDER_IDS.join(", ")}), not a {{token}}: the provider decides which credential is checked before the run starts`,
    );
  }
  return violations;
}

/** The engine fails a jev step before dispatch when any config token is unresolved. */
export function jevUnresolvedError(nodeId: string, tokens: string[]): string {
  const rendered = [...new Set(tokens)].map((token) => `{{${token}}}`).join(", ");
  return (
    `Jev node "${nodeId}" has unresolved interpolation token(s): ${rendered}. ` +
    "No request was sent. Declare the value in the node's inputs mapping or fix the path."
  );
}

// ─── Answer validation ──────────────────────────────────────

class JevContractError extends Error {}

function fail(message: string): never {
  throw new JevContractError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unit(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${what} must be a finite number between 0 and 1`);
  }
  return value;
}

/** Exact key set, each value in [0,1], sum within tolerance of 1. Returned as a fresh object. */
function distribution(value: unknown, keys: string[], what: string): Record<string, number> {
  if (!isRecord(value)) fail(`${what} must be an object`);
  const actual = Object.keys(value);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const extra = actual.filter((key) => !keys.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `${what} keys must be exactly the declared ${keys.length} option(s)` +
        (missing.length > 0 ? `; missing ${missing.length}` : "") +
        (extra.length > 0 ? `; ${extra.length} unexpected` : ""),
    );
  }
  const out: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const p = unit(value[key], `${what}["${key}"]`);
    out[key] = p;
    sum += p;
  }
  if (Math.abs(sum - 1) > DISTRIBUTION_TOLERANCE) {
    fail(`${what} must sum to 1 (within ${DISTRIBUTION_TOLERANCE})`);
  }
  return out;
}

/** Check one raw provider answer against its declared question. Extra provider fields are dropped. */
function validateAnswer(id: string, question: JevQuestion, raw: unknown): JevAnswer {
  const at = `answer "${id}"`;
  if (!isRecord(raw)) fail(`${at} must be an object`);
  if (raw.type !== question.type) {
    fail(`${at} has type ${JSON.stringify(raw.type)} but the question declares "${question.type}"`);
  }

  switch (question.type) {
    case "noul":
      return { type: "noul", noul: unit(raw.noul, `${at}.noul`) };

    case "choice": {
      const options = Object.keys(question.criteria);
      if (typeof raw.choice !== "string" || !Object.hasOwn(question.criteria, raw.choice)) {
        fail(`${at}.choice is not one of the declared options`);
      }
      return {
        type: "choice",
        choice: raw.choice,
        probabilities: distribution(raw.probabilities, options, `${at}.probabilities`),
        confidence: unit(raw.confidence, `${at}.confidence`),
      };
    }

    case "score": {
      const indices = question.criteria.map((_, index) => String(index));
      const top = indices.length - 1;
      if (
        typeof raw.score !== "number" ||
        !Number.isFinite(raw.score) ||
        raw.score < 0 ||
        raw.score > top
      ) {
        fail(`${at}.score must be a finite number between 0 and ${top}`);
      }
      if (!isRecord(raw.legend)) fail(`${at}.legend must be an object`);
      const legend: Record<string, z.infer<typeof JevEntrySchema>> = {};
      for (const key of indices) {
        if (!Object.hasOwn(raw.legend, key)) fail(`${at}.legend is missing level ${key}`);
        const entry = JevEntrySchema.safeParse(raw.legend[key]);
        if (!entry.success) fail(`${at}.legend["${key}"] must be a string, object, array, or null`);
        legend[key] = entry.data;
      }
      return {
        type: "score",
        score: raw.score,
        legend,
        probabilities: distribution(raw.probabilities, indices, `${at}.probabilities`),
        confidence: unit(raw.confidence, `${at}.confidence`),
      };
    }
  }
}

/**
 * Turn a parsed provider body into the node output, or throw a JevContractError.
 * Success requires exactly one valid answer per declared question. Nothing is
 * synthesized or normalized.
 */
export function validateJevResponse(
  questions: Record<string, JevQuestion>,
  body: unknown,
  requestId?: string,
): JevOutput {
  if (!isRecord(body)) fail("response body must be a JSON object");
  if (typeof body.model !== "string" || body.model === "") {
    fail("response is missing the model that produced the answers");
  }
  if (!isRecord(body.answers)) fail("response is missing the answers object");
  const usage = z
    .object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) })
    .safeParse(body.usage);
  if (!usage.success)
    fail("response usage must report non-negative integer input_tokens and output_tokens");

  const declared = Object.keys(questions);
  const unexpected = Object.keys(body.answers).filter((id) => !Object.hasOwn(questions, id));
  if (unexpected.length > 0)
    fail(`response contains ${unexpected.length} answer(s) for undeclared questions`);

  const answers: Record<string, JevAnswer> = {};
  for (const id of declared) {
    if (!Object.hasOwn(body.answers, id))
      fail(`response is missing the answer for question "${id}"`);
    const question = questions[id];
    if (!question) fail(`question "${id}" is not defined`);
    answers[id] = validateAnswer(id, question, body.answers[id]);
  }
  if (declared.length === 0) fail("a jev call needs at least one question");

  return {
    model: body.model,
    answers,
    usage: usage.data,
    ...(requestId ? { requestId } : {}),
  };
}

// ─── Transport ──────────────────────────────────────────────

export interface JevExecutorOptions {
  /** Transport. Tests inject a fake; production uses the global `fetch`. */
  fetch?: typeof fetch;
  /** Credential lookup for any provider. Defaults to each provider's own source (see `JEV_PROVIDERS`). */
  getApiKey?: (provider: JevProviderId) => Promise<string | null | undefined>;
  /** Environment the OpenRouter credential is resolved from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

type Attempt =
  | { kind: "ok"; text: string; requestId?: string }
  | { kind: "timeout" }
  | { kind: "fail"; message: string; retryable: boolean; retryAfterMs?: number };

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function readRequestId(headers: Headers): string | undefined {
  const value = headers.get("x-request-id") ?? headers.get("request-id");
  return value && REQUEST_ID_RE.test(value) ? value : undefined;
}

/** Retry-After as delta-seconds or an HTTP date, in ms. Undefined when absent or unparseable. */
function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Only a short identifier from the provider's error envelope. Never its message or echoed request. */
function readErrorCode(text: string): string | undefined {
  if (text.length === 0 || text.length > MAX_ERROR_BODY_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const nested = isRecord(parsed.error) ? parsed.error : undefined;
  const detail = isRecord(parsed.detail) ? parsed.detail : undefined;
  for (const candidate of [
    nested?.code,
    nested?.type,
    detail?.error_type,
    parsed.code,
    parsed.type,
  ]) {
    if (typeof candidate === "string" && ERROR_CODE_RE.test(candidate)) return candidate;
  }
  return undefined;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

// ─── Executor ───────────────────────────────────────────────

export class JevExecutor extends BaseExecutor<typeof JevConfigSchema, typeof JevOutputSchema> {
  readonly type = JEV_NODE_TYPE;
  readonly mode = "instant" as const;
  readonly configSchema = JevConfigSchema;
  readonly outputSchema = JevOutputSchema;

  constructor(
    deps: ExecutorDependencies,
    private readonly options: JevExecutorOptions = {},
  ) {
    super(deps);
  }

  private providerContext() {
    return { db: this.deps.db, env: this.options.env ?? process.env };
  }

  /**
   * One problem per provider the given nodes use whose credential (or deployment
   * setting) is not usable. Reads raw config: the provider is a static literal.
   */
  override async checkReadiness(
    nodes: readonly ExecutorReadinessNode[],
  ): Promise<ExecutorReadinessProblem[]> {
    const nodeIdsByProvider = new Map<JevProviderId, string[]>();
    for (const node of nodes) {
      // An unknown provider is a config error the schema reports; it names no credential.
      const id = jevProviderOf(node.config);
      if (id) nodeIdsByProvider.set(id, [...(nodeIdsByProvider.get(id) ?? []), node.id]);
    }
    const problems: ExecutorReadinessProblem[] = [];
    for (const [id, nodeIds] of nodeIdsByProvider) {
      const credential = await resolveJevCredential(
        id,
        this.providerContext(),
        this.options.getApiKey,
      );
      if (!credential.ok) problems.push({ nodeIds, message: credential.error });
    }
    return problems;
  }

  protected async execute(
    config: JevConfig,
    _context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<JevOutput>> {
    const providerId = config.provider;
    const provider: JevProvider = JEV_PROVIDERS[providerId];
    const credential = await resolveJevCredential(
      providerId,
      this.providerContext(),
      this.options.getApiKey,
    );
    if (!credential.ok) return { status: "failed", error: credential.error };
    const apiKey = credential.apiKey;

    const body = JSON.stringify({
      state: config.state,
      model: config.model ?? provider.defaultModel,
      questions: config.questions,
    });

    const scrub = (message: string) => message.split(apiKey).join("[REDACTED]");
    const sent = await this.send(providerId, apiKey, body, config.timeoutMs, config.maxRetries);
    if (!sent.ok) return { status: "failed", error: scrub(sent.error) };

    let parsed: unknown;
    try {
      parsed = JSON.parse(sent.text);
    } catch {
      return { status: "failed", error: "Jev response was not valid JSON" };
    }
    try {
      return {
        status: "success",
        output: validateJevResponse(config.questions, parsed, sent.requestId),
      };
    } catch (err) {
      if (err instanceof JevContractError) {
        return { status: "failed", error: scrub(`Jev response failed validation: ${err.message}`) };
      }
      throw err;
    }
  }

  /**
   * POST once, retrying only transient failures inside one time budget.
   * Retries: connection errors, HTTP 408 / 429 / 5xx (incl. 529). Never: 401, 422,
   * other 4xx, redirects, or a bad success body (the caller validates that).
   */
  private async send(
    providerId: JevProviderId,
    apiKey: string,
    body: string,
    timeoutMs: number,
    maxRetries: number,
  ): Promise<{ ok: true; text: string; requestId?: string } | { ok: false; error: string }> {
    const doFetch = this.options.fetch ?? fetch;
    const sleep = this.options.sleep ?? defaultSleep;
    const now = this.options.now ?? Date.now;
    const random = this.options.random ?? Math.random;

    const deadlineAt = now() + timeoutMs - DEADLINE_MARGIN_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - now()));
    const timedOut = () =>
      ({
        ok: false,
        error: `Jev request exceeded its ${timeoutMs}ms time budget`,
      }) as const;

    try {
      for (let attempt = 0; ; attempt++) {
        const result = await this.attemptOnce(
          doFetch,
          providerId,
          apiKey,
          body,
          controller.signal,
          now,
        );
        if (result.kind === "ok") {
          return { ok: true, text: result.text, requestId: result.requestId };
        }
        if (result.kind === "timeout" || controller.signal.aborted) return timedOut();

        const attempts = attempt + 1;
        const suffix = attempts > 1 ? ` after ${attempts} attempts` : "";
        if (!result.retryable || attempt >= maxRetries) {
          return { ok: false, error: `${result.message}${suffix}` };
        }

        const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
        const delay = result.retryAfterMs ?? Math.round(backoff * (0.5 + random() * 0.5));
        if (delay >= deadlineAt - now()) {
          return {
            ok: false,
            error: `${result.message}${suffix}; the ${delay}ms retry delay does not fit the ${timeoutMs}ms time budget`,
          };
        }
        await sleep(delay, controller.signal);
        if (controller.signal.aborted) return timedOut();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async attemptOnce(
    doFetch: typeof fetch,
    providerId: JevProviderId,
    apiKey: string,
    body: string,
    signal: AbortSignal,
    now: () => number,
  ): Promise<Attempt> {
    let res: Response;
    try {
      res = await doFetch(JEV_PROVIDERS[providerId].endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body,
        redirect: "manual",
        signal,
      });
    } catch (err) {
      if (signal.aborted) return { kind: "timeout" };
      const code = (err as { code?: unknown })?.code;
      const detail = typeof code === "string" && /^[A-Z0-9_]{3,40}$/.test(code) ? ` (${code})` : "";
      return {
        kind: "fail",
        message: `Jev request failed: network error${detail}`,
        retryable: true,
      };
    }

    const requestId = readRequestId(res.headers);
    const withId = (message: string) => (requestId ? `${message} [request ${requestId}]` : message);

    if (res.status >= 200 && res.status < 300) {
      let text: string;
      try {
        text = await res.text();
      } catch {
        if (signal.aborted) return { kind: "timeout" };
        return {
          kind: "fail",
          message: withId("Jev response body could not be read"),
          retryable: true,
        };
      }
      if (text.length > MAX_RESPONSE_CHARS) {
        return {
          kind: "fail",
          message: withId("Jev response exceeded the size limit"),
          retryable: false,
        };
      }
      return { kind: "ok", text, requestId };
    }

    if (res.status >= 300 && res.status < 400) {
      return {
        kind: "fail",
        message: withId(`Jev request was redirected (HTTP ${res.status}); redirects are refused`),
        retryable: false,
      };
    }

    let errorText = "";
    try {
      errorText = await res.text();
    } catch {
      if (signal.aborted) return { kind: "timeout" };
    }
    const code = readErrorCode(errorText);
    // The host answered but does not accept the key: name it, never retry.
    if (res.status === 401 || res.status === 403) {
      return {
        kind: "fail",
        message: withId(jevKeyRejectedMessage(providerId, res.status, code)),
        retryable: false,
      };
    }
    const detail = code ? ` (${code})` : "";
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    return {
      kind: "fail",
      message: withId(`Jev API returned HTTP ${res.status}${detail}`),
      retryable,
      retryAfterMs: retryable ? parseRetryAfter(res.headers.get("retry-after"), now()) : undefined,
    };
  }
}
