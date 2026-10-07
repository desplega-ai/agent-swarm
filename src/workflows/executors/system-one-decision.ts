import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import {
  type ApprovalOutcome,
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorReadinessNode,
  type ExecutorReadinessProblem,
  type ExecutorResult,
  type ResolvedApproval,
} from "./base";
import {
  ApproverConfigSchema,
  HITLTimeoutSchema,
  HumanInTheLoopExecutor,
  NotificationConfigSchema,
} from "./human-in-the-loop";
import {
  resolveSystemOneTarget,
  SYSTEM_ONE_DEFAULT_PROVIDER,
  SYSTEM_ONE_PROVIDER_IDS,
  SYSTEM_ONE_PROVIDERS,
  type SystemOneProvider,
  type SystemOneProviderId,
  systemOneKeyRejectedMessage,
  systemOneModelProblem,
  systemOneProviderOf,
  systemOneQuestionLimitProblem,
} from "./system-one-providers";
import { cloudflareErrorCode, SYSTEM_ONE_WIRE, SystemOneWireError } from "./system-one-wire";

// ─── Constants ──────────────────────────────────────────────

export const SYSTEM_ONE_DECISION_NODE_TYPE = "system-one-decision";

/**
 * The TypeSafe host and its credential name, kept as named exports. The set of
 * hosts a node may reach is `SYSTEM_ONE_PROVIDERS`: no endpoint, header, or key field
 * exists in a definition, only `provider`, an id from that list.
 */
export const SYSTEM_ONE_ENDPOINT = SYSTEM_ONE_PROVIDERS.typesafe.endpoint;
export const SYSTEM_ONE_API_KEY_CONFIG_KEY = SYSTEM_ONE_PROVIDERS.typesafe.keyName;

export const SYSTEM_ONE_DEFAULT_TIMEOUT_MS = 30_000;
export const SYSTEM_ONE_MIN_TIMEOUT_MS = 1_000;
export const SYSTEM_ONE_MAX_TIMEOUT_MS = 300_000;
export const SYSTEM_ONE_DEFAULT_MAX_RETRIES = 2;
export const SYSTEM_ONE_MAX_RETRIES_LIMIT = 3;

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

/** Output ports of a node that sets `humanReview`, the same names `human-in-the-loop` uses. */
const REVIEW_PORTS = ["approved", "rejected", "timeout"] as const;

/** Engine-level retries default to 3 when a stored policy omits the count. */
const ENGINE_RETRY_DEFAULT = 3;

// ─── Config schema ──────────────────────────────────────────

/** A description slot: string, JSON object, JSON array, or null (TypeSafe "advanced structure"). */
const SystemOneEntrySchema = z.union([
  z.string(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const SystemOneInstructionsSchema = SystemOneEntrySchema.refine(
  (value) => value !== null && !(typeof value === "string" && value.trim() === ""),
  { message: "instructions must not be null or blank" },
);

const SystemOneStateSchema = z.union([
  z.string().min(1, "state must not be empty"),
  z.array(z.string()).min(1, "state must not be an empty array"),
  z.record(z.string(), z.unknown()),
]);

const NoulQuestionSchema = z.strictObject({
  type: z.literal("noul"),
  instructions: SystemOneInstructionsSchema,
  criteria: z
    .strictObject({ true: SystemOneEntrySchema.optional(), false: SystemOneEntrySchema.optional() })
    .refine((criteria) => criteria.true !== undefined || criteria.false !== undefined, {
      message: "noul criteria must describe at least one of true / false",
    })
    .optional(),
});

const ChoiceQuestionSchema = z.strictObject({
  type: z.literal("choice"),
  instructions: SystemOneInstructionsSchema,
  criteria: z.record(z.string().min(1), SystemOneEntrySchema).refine(
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
  instructions: SystemOneInstructionsSchema,
  criteria: z.array(SystemOneEntrySchema).min(SCORE_MIN_LEVELS).max(SCORE_MAX_LEVELS),
});

export const SystemOneQuestionSchema = z.discriminatedUnion("type", [
  NoulQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
]);

const Unit = z.number().min(0).max(1);

const QUESTION_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED_QUESTION_IDS = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);

const SystemOnePrimitiveTypeSchema = z.enum(["noul", "choice", "score"]);

/**
 * Send an answer to a person when the model is unsure. The approval machinery is
 * the `human-in-the-loop` executor's: same approvers, timeout, notifications,
 * `waiting` run state, and dashboard card. Only the band and the card content
 * are this node's.
 */
const HumanReviewSchema = z.strictObject({
  /** Review when `min <= confidence <= max`. Both ends count as in the band. */
  band: z
    .strictObject({ min: Unit, max: Unit })
    .refine((band) => band.min <= band.max, { message: "band.min must not exceed band.max" }),
  approvers: ApproverConfigSchema,
  /** Card title. Defaults to `Review decision: <node id>`. */
  title: z.string().min(1).optional(),
  timeout: HITLTimeoutSchema.optional(),
  notifications: z.array(NotificationConfigSchema).optional(),
});

export type SystemOneHumanReview = z.infer<typeof HumanReviewSchema>;

export const SystemOneDecisionConfigSchema = z
  .strictObject({
    provider: z.enum(SYSTEM_ONE_PROVIDER_IDS).default(SYSTEM_ONE_DEFAULT_PROVIDER),
    /** Provider-specific model id. Unset means the provider's default. */
    model: z.string().min(1).optional(),
    state: SystemOneStateSchema,
    timeoutMs: z
      .number()
      .int()
      .min(SYSTEM_ONE_MIN_TIMEOUT_MS)
      .max(SYSTEM_ONE_MAX_TIMEOUT_MS)
      .default(SYSTEM_ONE_DEFAULT_TIMEOUT_MS),
    maxRetries: z
      .number()
      .int()
      .min(0)
      .max(SYSTEM_ONE_MAX_RETRIES_LIMIT)
      .default(SYSTEM_ONE_DEFAULT_MAX_RETRIES),
    questions: z.record(
      z
        .string()
        .regex(
          QUESTION_ID_RE,
          "question ids must start with a letter or underscore and use only letters, digits, _ or -",
        ),
      SystemOneQuestionSchema,
    ),
    returns: z.record(z.string(), z.strictObject({ type: SystemOnePrimitiveTypeSchema })),
    /** Optional. Absent means every valid answer passes straight through. */
    humanReview: HumanReviewSchema.optional(),
  })
  .superRefine((config, ctx) => {
    const questionIds = Object.keys(config.questions);
    if (questionIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: "system-one-decision needs at least one question",
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
    // Provider limits. A {{token}} model is skipped at save and checked again at run,
    // where the interpolated config is parsed by this same schema.
    const modelProblem = systemOneModelProblem(
      config.provider,
      config.model ?? (SYSTEM_ONE_PROVIDERS[config.provider] as SystemOneProvider).defaultModel,
    );
    if (modelProblem) ctx.addIssue({ code: "custom", path: ["model"], message: modelProblem });
    const limitProblem = systemOneQuestionLimitProblem(config.provider, questionIds.length);
    if (limitProblem) ctx.addIssue({ code: "custom", path: ["questions"], message: limitProblem });
  });

export type SystemOneDecisionConfig = z.infer<typeof SystemOneDecisionConfigSchema>;
export type SystemOneQuestion = z.infer<typeof SystemOneQuestionSchema>;

// ─── Output schema ──────────────────────────────────────────

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
  legend: z.record(z.string(), SystemOneEntrySchema),
  probabilities: z.record(z.string(), Unit),
  confidence: Unit,
});

const SystemOneAnswerSchema = z.discriminatedUnion("type", [
  NoulAnswerSchema,
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
]);

/** Present only when the node sets `humanReview`. */
const ReviewQuestionSchema = z.strictObject({
  /** The number the band was tested against (see `answerConfidence`). */
  confidence: Unit,
  inBand: z.boolean(),
  /** Who produced the value in `answers[id]`. */
  decidedBy: z.enum(["model", "human"]),
  /** The model's own answer, kept when a person decided so an override stays auditable. */
  modelAnswer: z.union([z.string(), z.number()]).optional(),
});

const ReviewSchema = z.strictObject({
  /** `pending` is stored on the parked step only; a finished node never reports it. */
  status: z.enum(["not_required", "pending", "approved", "rejected", "timeout"]),
  /** The approval request a person answered, when one was raised. */
  approvalRequestId: z.string().optional(),
  /** Why an approved review was turned into `rejected`. */
  reason: z.string().optional(),
  questions: z.record(z.string(), ReviewQuestionSchema),
});

export const SystemOneDecisionOutputSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), SystemOneAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }),
  requestId: z.string().optional(),
  /**
   * The checkpoint that answered, when the host reports one (laya's `routing.model`).
   * `model` names the service and stays the same across checkpoints, so this is what
   * a run records to say which one was used.
   */
  routing: z.strictObject({ model: z.string().min(1) }).optional(),
  review: ReviewSchema.optional(),
});

export type SystemOneAnswer = z.infer<typeof SystemOneAnswerSchema>;
export type SystemOneDecisionOutput = z.infer<typeof SystemOneDecisionOutputSchema>;

// ─── Engine-facing rules (authoring + runtime) ──────────────

interface RetryShape {
  maxRetries?: number;
}

/**
 * Why a `system-one-decision` node may not carry an engine retry policy.
 *
 * The executor owns its transient retries (`config.maxRetries`). Engine retries
 * are not status-aware, so a node-level or validation retry would re-send 401 / 422
 * requests and multiply the attempt count. Returns one message per violation.
 */
export function systemOneRetryViolations(node: {
  id: string;
  type: string;
  retry?: RetryShape | null;
  validation?: { retry?: RetryShape | null } | null;
}): string[] {
  if (node.type !== SYSTEM_ONE_DECISION_NODE_TYPE) return [];
  const violations: string[] = [];
  const attempts = (retry: RetryShape | null | undefined) =>
    retry ? (retry.maxRetries ?? ENGINE_RETRY_DEFAULT) : 0;
  if (attempts(node.retry) > 0) {
    violations.push(
      `Node "${node.id}" (system-one-decision) must not set retry.maxRetries > 0: the system-one-decision executor retries transient transport errors itself (config.maxRetries), and engine retries would re-send rejected requests`,
    );
  }
  if (attempts(node.validation?.retry) > 0) {
    violations.push(
      `Node "${node.id}" (system-one-decision) must not set validation.retry.maxRetries > 0: a validation-driven retry would send another paid request`,
    );
  }
  return violations;
}

/** Static-shape rules that a per-field schema cannot express (question ids, return types, and the provider are static). */
export function systemOneStaticShapeViolations(node: {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next?: string | string[] | Record<string, string> | null;
}): string[] {
  if (node.type !== SYSTEM_ONE_DECISION_NODE_TYPE) return [];
  const violations: string[] = [];
  for (const field of ["questions", "returns"] as const) {
    const value = node.config[field];
    if (
      value !== undefined &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      violations.push(
        `Node "${node.id}" (system-one-decision) config.${field} must be an object: question ids and return types are static, only state and descriptions may use {{tokens}}`,
      );
    }
  }
  const provider = node.config.provider;
  if (typeof provider === "string" && provider.includes("{{")) {
    violations.push(
      `Node "${node.id}" (system-one-decision) config.provider must be a literal (${SYSTEM_ONE_PROVIDER_IDS.join(", ")}), not a {{token}}: the provider decides which credential is checked before the run starts`,
    );
  }
  if (isRecord(node.config.humanReview) && node.next != null) {
    // A rejection or a timeout must not run the same successors as an accepted answer.
    // Only a port map can tell them apart, so a string or list `next` is refused.
    if (typeof node.next === "string" || Array.isArray(node.next)) {
      violations.push(
        `Node "${node.id}" (system-one-decision) sets humanReview, so next must map output ports (${REVIEW_PORTS.join(", ")}): a single or list next would run the same successors after a rejection or a timeout`,
      );
    } else {
      const ports = Object.keys(node.next);
      const unknown = ports.filter((port) => !(REVIEW_PORTS as readonly string[]).includes(port));
      if (unknown.length > 0) {
        violations.push(
          `Node "${node.id}" (system-one-decision) sets humanReview, so next ports must be ${REVIEW_PORTS.join(", ")}; got ${unknown.map((port) => `"${port}"`).join(", ")}`,
        );
      }
      if (!ports.includes("approved")) {
        violations.push(
          `Node "${node.id}" (system-one-decision) sets humanReview, so next must define the "approved" port: it carries every answer that is accepted, by the model or by a person`,
        );
      }
    }
  }
  return violations;
}

/** The engine fails a system-one-decision step before dispatch when any config token is unresolved. */
export function systemOneUnresolvedError(nodeId: string, tokens: string[]): string {
  const rendered = [...new Set(tokens)].map((token) => `{{${token}}}`).join(", ");
  return (
    `SystemOne Decision node "${nodeId}" has unresolved interpolation token(s): ${rendered}. ` +
    "No request was sent. Declare the value in the node's inputs mapping or fix the path."
  );
}

// ─── Answer validation ──────────────────────────────────────

class SystemOneContractError extends Error {}

function fail(message: string): never {
  throw new SystemOneContractError(message);
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

type ConfidenceField = SystemOneProvider["confidenceField"];

/** Check one raw provider answer against its declared question. Extra provider fields are dropped. */
function validateAnswer(
  id: string,
  question: SystemOneQuestion,
  raw: unknown,
  confidenceField: ConfidenceField,
): SystemOneAnswer {
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
        confidence: unit(raw[confidenceField], `${at}.${confidenceField}`),
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
      const legend: Record<string, z.infer<typeof SystemOneEntrySchema>> = {};
      for (const key of indices) {
        if (!Object.hasOwn(raw.legend, key)) fail(`${at}.legend is missing level ${key}`);
        const entry = SystemOneEntrySchema.safeParse(raw.legend[key]);
        if (!entry.success) fail(`${at}.legend["${key}"] must be a string, object, array, or null`);
        legend[key] = entry.data;
      }
      return {
        type: "score",
        score: raw.score,
        legend,
        probabilities: distribution(raw.probabilities, indices, `${at}.probabilities`),
        confidence: unit(raw[confidenceField], `${at}.${confidenceField}`),
      };
    }
  }
}

/** Longest checkpoint name kept from a host's `routing.model`. */
const MAX_ROUTING_MODEL_CHARS = 128;

/** The checkpoint a host reports, or undefined. It is a record of a run, so a malformed value is left out, not a failure. */
function readRoutingModel(routing: unknown): string | undefined {
  if (!isRecord(routing)) return undefined;
  const { model } = routing;
  return typeof model === "string" && model !== "" && model.length <= MAX_ROUTING_MODEL_CHARS
    ? model
    : undefined;
}

/**
 * Turn a parsed provider body into the node output, or throw a SystemOneContractError.
 * Success requires exactly one valid answer per declared question. Nothing is
 * synthesized or normalized. `confidenceField` names the field a `choice` or `score`
 * answer's confidence is read from (see `SystemOneProvider.confidenceField`).
 */
export function validateSystemOneResponse(
  questions: Record<string, SystemOneQuestion>,
  body: unknown,
  requestId?: string,
  confidenceField: ConfidenceField = "confidence",
): SystemOneDecisionOutput {
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

  const answers: Record<string, SystemOneAnswer> = {};
  for (const id of declared) {
    if (!Object.hasOwn(body.answers, id))
      fail(`response is missing the answer for question "${id}"`);
    const question = questions[id];
    if (!question) fail(`question "${id}" is not defined`);
    answers[id] = validateAnswer(id, question, body.answers[id], confidenceField);
  }
  if (declared.length === 0) fail("a system-one-decision call needs at least one question");

  const routingModel = readRoutingModel(body.routing);
  return {
    model: body.model,
    answers,
    usage: usage.data,
    ...(requestId ? { requestId } : {}),
    ...(routingModel ? { routing: { model: routingModel } } : {}),
  };
}

// ─── Human review ───────────────────────────────────────────

type ReviewQuestions = z.infer<typeof ReviewSchema>["questions"];

/** Approval question id. `$` cannot start a question id, so it never collides with one. */
const REVIEW_CONFIRM_ID = "$confirm";
const REVIEW_STATE_CHARS = 2_000;
const REVIEW_LABEL_CHARS = 160;
const REVIEW_OPTION_CHARS = 200;

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * The number `humanReview.band` is tested against. A `choice` or `score` answer
 * carries `confidence`, the field its provider names (`confidenceField`) read at
 * validation. A `noul` answer reports none, so it is the probability of the side
 * the model took, max(P(true), P(false)). The output never gains a confidence
 * field for it.
 */
export function answerConfidence(answer: SystemOneAnswer): number {
  return answer.type === "noul"
    ? round6(Math.max(answer.noul, 1 - answer.noul))
    : answer.confidence;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A criterion or instruction is a string, an object, an array, or null. Show it as text. */
function showEntry(entry: unknown, max: number): string {
  return clip(typeof entry === "string" ? entry : (JSON.stringify(entry) ?? ""), max);
}

/** The model's own answer in a form that fits a review record. */
function modelAnswerOf(answer: SystemOneAnswer): string | number {
  return answer.type === "choice"
    ? answer.choice
    : answer.type === "score"
      ? answer.score
      : answer.noul;
}

/**
 * The approval card a person answers. One `approval` question accepts or rejects
 * the whole decision. Each answer in the band gets a question of the same kind,
 * left empty to confirm what the model said or set to replace it.
 */
function buildReviewCard(
  nodeId: string,
  config: SystemOneDecisionConfig,
  review: SystemOneHumanReview,
  parked: SystemOneDecisionOutput,
) {
  const state = scrubSecrets(
    typeof config.state === "string" ? config.state : (JSON.stringify(config.state) ?? ""),
  );
  const questions: Record<string, unknown>[] = [
    {
      id: REVIEW_CONFIRM_ID,
      type: "approval",
      label: "Accept these answers and continue?",
      required: true,
      description: `Model ${parked.model}. Input: ${clip(state, REVIEW_STATE_CHARS)}`,
    },
  ];
  for (const [id, info] of Object.entries(parked.review?.questions ?? {})) {
    if (!info.inBand) continue;
    const question = config.questions[id];
    const answer = parked.answers[id];
    if (!question || !answer) continue;
    const label = `${id}: ${showEntry(question.instructions, REVIEW_LABEL_CHARS)}`;
    const said = `The model answered ${JSON.stringify(modelAnswerOf(answer))} at confidence ${info.confidence}.`;
    if (question.type === "choice" && answer.type === "choice") {
      questions.push({
        id,
        type: "single-select",
        label,
        required: false,
        description: `${said} Leave empty to confirm it, or pick another option.`,
        options: Object.entries(question.criteria).map(([value, entry]) => ({
          value,
          label: value,
          ...(typeof entry === "string" && entry
            ? { description: clip(entry, REVIEW_OPTION_CHARS) }
            : {}),
        })),
      });
    } else if (question.type === "score" && answer.type === "score") {
      questions.push({
        id,
        type: "single-select",
        label,
        required: false,
        description: `${said} Leave empty to confirm it, or pick a level.`,
        options: question.criteria.map((entry, level) => ({
          value: String(level),
          label: `${level}: ${showEntry(entry, REVIEW_OPTION_CHARS)}`,
        })),
      });
    } else if (question.type === "noul" && answer.type === "noul") {
      questions.push({
        id,
        type: "boolean",
        label,
        required: false,
        defaultValue: answer.noul >= 0.5,
        description: `${said} The switch starts on the side the model took.`,
      });
    }
  }
  return {
    title: review.title ?? `Review decision: ${nodeId}`,
    questions,
    approvers: review.approvers,
    ...(review.timeout ? { timeout: review.timeout } : {}),
    ...(review.notifications ? { notifications: review.notifications } : {}),
  };
}

type HumanAnswer =
  | { kind: "confirm" }
  | { kind: "override"; answer: SystemOneAnswer }
  | { kind: "invalid" };

/** What a person's response to one in-band question means for the model's answer. */
function readHumanAnswer(answer: SystemOneAnswer, response: unknown): HumanAnswer {
  if (response === undefined || response === null || response === "") return { kind: "confirm" };
  switch (answer.type) {
    case "choice":
      if (typeof response !== "string" || !Object.hasOwn(answer.probabilities, response)) {
        return { kind: "invalid" };
      }
      return response === answer.choice
        ? { kind: "confirm" }
        : { kind: "override", answer: { ...answer, choice: response } };
    case "score": {
      if (typeof response !== "string" || !Object.hasOwn(answer.legend, response)) {
        return { kind: "invalid" };
      }
      const level = Number(response);
      return level === answer.score
        ? { kind: "confirm" }
        : { kind: "override", answer: { ...answer, score: level } };
    }
    case "noul":
      if (typeof response !== "boolean") return { kind: "invalid" };
      return response === answer.noul >= 0.5
        ? { kind: "confirm" }
        : { kind: "override", answer: { ...answer, noul: response ? 1 : 0 } };
  }
}

/**
 * Turn a resolved approval into the node's final output and port.
 *
 * - approved: answers a person confirmed or replaced are marked `decidedBy:
 *   "human"`, with the model's own answer kept in `review.questions`. A person's
 *   answer never touches `probabilities`, `legend`, or `confidence`: those always
 *   describe the model. A replaced `noul` becomes 1 or 0, a person being certain.
 * - rejected or timeout: nobody accepted an answer, so `answers` stays the
 *   model's and the node leaves through the `rejected` or `timeout` port.
 * - an approved response that names something outside the options is treated as
 *   rejected, never as a confirmation.
 *
 * Returns null when the parked output is not a pending decision; the caller then
 * falls back to the plain human-in-the-loop output so the run does not wedge.
 */
export function resolveReviewedDecision(
  parkedOutput: unknown,
  approval: ResolvedApproval,
): ApprovalOutcome | null {
  const parked = SystemOneDecisionOutputSchema.safeParse(parkedOutput);
  if (!parked.success || parked.data.review?.status !== "pending") return null;
  const decision = parked.data;
  const parkedQuestions = decision.review?.questions ?? {};

  const finish = (
    status: ResolvedApproval["status"],
    answers: SystemOneDecisionOutput["answers"],
    questions: ReviewQuestions,
    reason?: string,
  ): ApprovalOutcome => ({
    output: {
      ...decision,
      answers,
      review: {
        status,
        approvalRequestId: approval.requestId,
        ...(reason ? { reason } : {}),
        questions,
      },
    } satisfies SystemOneDecisionOutput,
    nextPort: status,
  });

  if (approval.status !== "approved") {
    return finish(approval.status, decision.answers, parkedQuestions);
  }

  const answers = { ...decision.answers };
  const questions: ReviewQuestions = { ...parkedQuestions };
  for (const [id, info] of Object.entries(parkedQuestions)) {
    const modelAnswer = decision.answers[id];
    if (!info.inBand || !modelAnswer) continue;
    const human = readHumanAnswer(modelAnswer, approval.responses?.[id]);
    if (human.kind === "invalid") {
      return finish(
        "rejected",
        decision.answers,
        parkedQuestions,
        `The response for "${id}" is not one of its options`,
      );
    }
    if (human.kind === "override") answers[id] = human.answer;
    questions[id] = { ...info, decidedBy: "human", modelAnswer: modelAnswerOf(modelAnswer) };
  }
  return finish("approved", answers, questions);
}

// ─── Transport ──────────────────────────────────────────────

export interface SystemOneDecisionExecutorOptions {
  /** Transport. Tests inject a fake; production uses the global `fetch`. */
  fetch?: typeof fetch;
  /** Credential lookup for any provider. Defaults to each provider's own source (see `SYSTEM_ONE_PROVIDERS`). */
  getApiKey?: (provider: SystemOneProviderId) => Promise<string | null | undefined>;
  /** Base-URL lookup for a provider with no fixed host (`laya`). Defaults to its global config value. */
  getServerUrl?: (provider: SystemOneProviderId) => Promise<string | null | undefined>;
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
  // Cloudflare marks every response with `cf-ray` and sends no request id.
  const value = headers.get("x-request-id") ?? headers.get("request-id") ?? headers.get("cf-ray");
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
  // Cloudflare's envelope: `{ success: false, errors: [{ code: 10000, message }] }`.
  return cloudflareErrorCode(parsed);
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

export class SystemOneDecisionExecutor extends BaseExecutor<
  typeof SystemOneDecisionConfigSchema,
  typeof SystemOneDecisionOutputSchema
> {
  readonly type = SYSTEM_ONE_DECISION_NODE_TYPE;
  // Waits only when `humanReview` sends an answer to a person; otherwise it answers at once.
  readonly mode = "async" as const;
  readonly configSchema = SystemOneDecisionConfigSchema;
  readonly outputSchema = SystemOneDecisionOutputSchema;

  constructor(
    deps: ExecutorDependencies,
    private readonly options: SystemOneDecisionExecutorOptions = {},
  ) {
    super(deps);
  }

  private providerContext() {
    return { db: this.deps.db, env: this.options.env ?? process.env };
  }

  private resolveTarget(id: SystemOneProviderId, model?: string) {
    return resolveSystemOneTarget(id, this.providerContext(), {
      apiKey: this.options.getApiKey,
      serverUrl: this.options.getServerUrl,
      model,
    });
  }

  /**
   * One problem per provider the given nodes use whose credential (or deployment
   * setting) is not usable. Reads raw config: the provider is a static literal.
   */
  override async checkReadiness(
    nodes: readonly ExecutorReadinessNode[],
  ): Promise<ExecutorReadinessProblem[]> {
    const nodeIdsByProvider = new Map<SystemOneProviderId, string[]>();
    for (const node of nodes) {
      // An unknown provider is a config error the schema reports; it names no credential.
      const id = systemOneProviderOf(node.config);
      if (id) nodeIdsByProvider.set(id, [...(nodeIdsByProvider.get(id) ?? []), node.id]);
    }
    const problems: ExecutorReadinessProblem[] = [];
    for (const [id, nodeIds] of nodeIdsByProvider) {
      const target = await this.resolveTarget(id);
      if (!target.ok) problems.push({ nodeIds, message: target.error });
    }
    return problems;
  }

  protected async execute(
    config: SystemOneDecisionConfig,
    context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<SystemOneDecisionOutput>> {
    if (config.humanReview) {
      // A step that already raised its approval request (a crash between the request
      // and the `waiting` state, then a re-run) must not buy a second decision.
      const existing = await this.deps.db.getApprovalRequestByStepId(meta.stepId);
      if (existing) {
        return this.handOffToReviewer(config, await this.readParked(meta.stepId), context, meta);
      }
    }

    const providerId = config.provider;
    const provider: SystemOneProvider = SYSTEM_ONE_PROVIDERS[providerId];

    // A provider with no default sends no `model` when the node sets none.
    const model = config.model ?? provider.defaultModel;
    const modelProblem = systemOneModelProblem(providerId, model);
    if (modelProblem) return { status: "failed", error: modelProblem };
    const target = await this.resolveTarget(providerId, model);
    if (!target.ok) return { status: "failed", error: target.error };
    const { apiKey, endpoint } = target;

    const wire = provider.wire ?? SYSTEM_ONE_WIRE;
    const body = JSON.stringify(wire.buildRequest(config, model));

    const scrub = (message: string) => message.split(apiKey).join("[REDACTED]");
    const sent = await this.send(
      providerId,
      endpoint,
      apiKey,
      body,
      config.timeoutMs,
      config.maxRetries,
    );
    if (!sent.ok) return { status: "failed", error: scrub(sent.error) };

    let parsed: unknown;
    try {
      parsed = JSON.parse(sent.text);
    } catch {
      return { status: "failed", error: "SystemOne response was not valid JSON" };
    }
    let decision: SystemOneDecisionOutput;
    try {
      decision = validateSystemOneResponse(
        config.questions,
        wire.toSystemOne(parsed, { questions: config.questions, model }),
        sent.requestId,
        provider.confidenceField,
      );
    } catch (err) {
      if (err instanceof SystemOneWireError) {
        const withId = sent.requestId ? `${err.message} [request ${sent.requestId}]` : err.message;
        return { status: "failed", error: scrub(withId) };
      }
      if (err instanceof SystemOneContractError) {
        return {
          status: "failed",
          error: scrub(`SystemOne response failed validation: ${err.message}`),
        };
      }
      throw err;
    }
    if (!config.humanReview) return { status: "success", output: decision };
    return this.reviewDecision(config, config.humanReview, decision, context, meta);
  }

  /**
   * Test the answers against the band. Nothing in it: the decision passes with a
   * `not_required` review. Something in it: store the decision on the step, then
   * raise the approval request and wait.
   */
  private async reviewDecision(
    config: SystemOneDecisionConfig,
    review: SystemOneHumanReview,
    decision: SystemOneDecisionOutput,
    context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<SystemOneDecisionOutput>> {
    const questions: ReviewQuestions = {};
    for (const [id, answer] of Object.entries(decision.answers)) {
      const confidence = answerConfidence(answer);
      questions[id] = {
        confidence,
        inBand: confidence >= review.band.min && confidence <= review.band.max,
        decidedBy: "model",
      };
    }
    if (!Object.values(questions).some((question) => question.inBand)) {
      return {
        status: "success",
        output: { ...decision, review: { status: "not_required", questions } },
        nextPort: "approved",
      };
    }
    const parked: SystemOneDecisionOutput = {
      ...decision,
      review: { status: "pending", questions },
    };
    // The answer must survive the wait: the resume path reads it back from the step.
    await this.deps.db.updateWorkflowRunStep(meta.stepId, { output: parked });
    return this.handOffToReviewer(config, parked, context, meta);
  }

  private async readParked(stepId: string): Promise<SystemOneDecisionOutput | null> {
    const step = await this.deps.db.getWorkflowRunStep(stepId);
    const parked = SystemOneDecisionOutputSchema.safeParse(step?.output);
    return parked.success && parked.data.review?.status === "pending" ? parked.data : null;
  }

  /**
   * Raise the approval request through the `human-in-the-loop` executor, so
   * approvers, timeout, notifications, idempotency, and the `waiting` state are
   * its own. A request that is already answered comes back resolved here, and is
   * shaped the way the resume path would shape it.
   */
  private async handOffToReviewer(
    config: SystemOneDecisionConfig,
    parked: SystemOneDecisionOutput | null,
    context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<SystemOneDecisionOutput>> {
    if (!parked || !config.humanReview) {
      return {
        status: "failed",
        error:
          "The decision this step parked with is missing, so its approval cannot be resumed. Run the node again.",
      };
    }
    const result = await new HumanInTheLoopExecutor(this.deps).run({
      config: buildReviewCard(meta.nodeId, config, config.humanReview, parked),
      context,
      meta,
    });
    if (result.status === "failed") return { status: "failed", error: result.error };
    // The approval is pending: the engine parks the step and the answer resumes it.
    if ("async" in result) return result as ExecutorResult<SystemOneDecisionOutput>;

    const answered = result.output;
    const outcome = answered
      ? this.resolveApproval(parked, {
          requestId: answered.requestId,
          status: answered.status as ResolvedApproval["status"],
          responses: answered.responses,
        })
      : null;
    if (!outcome) {
      return {
        status: "failed",
        error: "The approval was answered but its result could not be applied",
      };
    }
    return {
      status: "success",
      output: outcome.output as SystemOneDecisionOutput,
      nextPort: outcome.nextPort,
    };
  }

  /** Called by the resume and recovery paths when a person answers this node's approval. */
  override resolveApproval(
    parkedOutput: unknown,
    approval: ResolvedApproval,
  ): ApprovalOutcome | null {
    return resolveReviewedDecision(parkedOutput, approval);
  }

  /**
   * POST once, retrying only transient failures inside one time budget.
   * Retries: connection errors, HTTP 408 / 429 / 5xx (incl. 529). Never: 401, 422,
   * other 4xx, redirects, or a bad success body (the caller validates that).
   */
  private async send(
    providerId: SystemOneProviderId,
    endpoint: string,
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
        error: `SystemOne request exceeded its ${timeoutMs}ms time budget`,
      }) as const;

    try {
      for (let attempt = 0; ; attempt++) {
        const result = await this.attemptOnce(
          doFetch,
          providerId,
          endpoint,
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
    providerId: SystemOneProviderId,
    endpoint: string,
    apiKey: string,
    body: string,
    signal: AbortSignal,
    now: () => number,
  ): Promise<Attempt> {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
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
        message: `SystemOne request failed: network error${detail}`,
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
          message: withId("SystemOne response body could not be read"),
          retryable: true,
        };
      }
      if (text.length > MAX_RESPONSE_CHARS) {
        return {
          kind: "fail",
          message: withId("SystemOne response exceeded the size limit"),
          retryable: false,
        };
      }
      return { kind: "ok", text, requestId };
    }

    if (res.status >= 300 && res.status < 400) {
      return {
        kind: "fail",
        message: withId(
          `SystemOne request was redirected (HTTP ${res.status}); redirects are refused`,
        ),
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
        message: withId(systemOneKeyRejectedMessage(providerId, res.status, code)),
        retryable: false,
      };
    }
    const detail = code ? ` (${code})` : "";
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    return {
      kind: "fail",
      message: withId(`SystemOne API returned HTTP ${res.status}${detail}`),
      retryable,
      retryAfterMs: retryable ? parseRetryAfter(res.headers.get("retry-after"), now()) : undefined,
    };
  }
}
