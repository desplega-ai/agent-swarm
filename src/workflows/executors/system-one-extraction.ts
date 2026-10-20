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
  resolveSystemOneTarget,
  SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER,
  SYSTEM_ONE_EXTRACT_PROVIDER_IDS,
  SYSTEM_ONE_HOSTS,
  type SystemOneExtractProviderId,
  type SystemOneHost,
  systemOneExtractProviderOf,
  systemOneModelProblem,
} from "./system-one-providers";
import {
  SYSTEM_ONE_DEFAULT_MAX_RETRIES,
  SYSTEM_ONE_DEFAULT_TIMEOUT_MS,
  SYSTEM_ONE_MAX_RETRIES_LIMIT,
  SYSTEM_ONE_MAX_TIMEOUT_MS,
  SYSTEM_ONE_MIN_TIMEOUT_MS,
  type SystemOneTransportOptions,
  sendSystemOneRequest,
} from "./system-one-transport";
import { isRecord, SystemOneWireError, VALIDATION_PREFIX } from "./system-one-wire";

/**
 * `system-one-extraction`: read typed values out of a text (and up to four images)
 * with a System One extraction model, Cloudflare's Clairic by default. Each field
 * declares its type; the answer for it is typed the same way, with the model's own
 * uncertainty (`p_null`, `confidence`, quantiles) next to the value, so a later
 * node branches on `<node>.answers.<field>.value` or on how sure the model was.
 *
 * The host, credential, endpoint, transport, and messages are the ones
 * `system-one-decision` uses (`SYSTEM_ONE_HOSTS`); only the request and answers differ.
 */

// ─── Constants ──────────────────────────────────────────────

export const SYSTEM_ONE_EXTRACTION_NODE_TYPE = "system-one-extraction";

export const EXTRACTION_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "time",
  "datetime",
  "duration",
  "list",
  "estimate",
  "forecast",
] as const;

const DURATION_UNITS = ["seconds", "minutes", "hours", "days", "weeks", "months", "years"] as const;
const LIST_ITEMS = ["text", "number", "date"] as const;
const FORECAST_INTERVALS = [
  "step",
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "year",
] as const;

/** Field ids double as output paths (`answers.<id>.value`), so no dots. Clairic allows 64 characters. */
const FIELD_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const FIELD_ID_MESSAGE =
  "field ids must start with a letter or underscore, use only letters, digits, _ or -, and be at most 64 characters";
const RESERVED_FIELD_IDS = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES_TOTAL_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/i;

// ─── Config schema ──────────────────────────────────────────

const Instructions = z.string().trim().min(1, "instructions must not be blank");
const NullThreshold = z
  .number()
  .gt(0, "null_threshold must be above 0")
  .max(1, "null_threshold must be at most 1");
const Decimals = z.number().int().min(0).max(6);
const Unit = z.string().trim().min(1, "unit must not be blank");
const Scale = z.enum(["linear", "log"]);
const Bound = z.union([
  z.number(),
  z.string().regex(ISO_DATE_RE, "must be a number or an ISO date (YYYY-MM-DD)"),
]);

const plain = { instructions: Instructions.optional(), null_threshold: NullThreshold.optional() };

const TextField = z.strictObject({ type: z.literal("text"), ...plain });
const NumberField = z.strictObject({
  type: z.literal("number"),
  ...plain,
  unit: Unit.optional(),
  integer: z.boolean().optional(),
  decimals: Decimals.optional(),
});
const DateField = z.strictObject({ type: z.literal("date"), ...plain });
const TimeField = z.strictObject({ type: z.literal("time"), ...plain });
const DatetimeField = z.strictObject({ type: z.literal("datetime"), ...plain });
const DurationField = z.strictObject({
  type: z.literal("duration"),
  ...plain,
  unit: z.enum(DURATION_UNITS).optional(),
  integer: z.boolean().optional(),
  decimals: Decimals.optional(),
});
const ListField = z.strictObject({
  type: z.literal("list"),
  instructions: Instructions.optional(),
  items: z.enum(LIST_ITEMS),
  decimals: Decimals.optional(),
});
const EstimateField = z.strictObject({
  type: z.literal("estimate"),
  instructions: Instructions.optional(),
  unit: Unit.optional(),
  min: Bound,
  max: Bound,
  step: z.union([z.number().positive(), z.enum(["month", "year"])]).optional(),
  scale: Scale.optional(),
});
const ForecastField = z.strictObject({
  type: z.literal("forecast"),
  instructions: Instructions.optional(),
  unit: Unit.optional(),
  min: z.number(),
  max: z.number(),
  horizon: z.number().int().min(1).max(64).optional(),
  interval: z.enum(FORECAST_INTERVALS).optional(),
  scale: Scale.optional(),
});

export const SystemOneExtractionFieldSchema = z
  .discriminatedUnion("type", [
    TextField,
    NumberField,
    DateField,
    TimeField,
    DatetimeField,
    DurationField,
    ListField,
    EstimateField,
    ForecastField,
  ])
  .superRefine((field, ctx) => {
    if ("integer" in field && field.integer && field.decimals !== undefined && field.decimals > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["decimals"],
        message: "an integer field cannot also set decimals above 0",
      });
    }
    if (field.type === "list" && field.decimals !== undefined && field.items !== "number") {
      ctx.addIssue({
        code: "custom",
        path: ["decimals"],
        message: 'decimals applies only to a list of items "number"',
      });
    }
    if (field.type === "estimate" || field.type === "forecast") {
      const { min, max } = field;
      if (typeof min !== typeof max) {
        ctx.addIssue({
          code: "custom",
          path: ["max"],
          message: "min and max must both be numbers or both be ISO dates",
        });
      } else if (min >= max) {
        ctx.addIssue({ code: "custom", path: ["max"], message: "max must be greater than min" });
      }
      if (field.scale === "log" && typeof min === "number" && min <= 0) {
        ctx.addIssue({
          code: "custom",
          path: ["min"],
          message: 'a "log" scale needs min above 0',
        });
      }
      if (
        field.type === "estimate" &&
        typeof field.step === "string" &&
        typeof field.min === "number"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["step"],
          message: `step "${field.step}" applies only to a date estimate (ISO date min and max)`,
        });
      }
    }
  });

export type SystemOneExtractionField = z.infer<typeof SystemOneExtractionFieldSchema>;

/** An embedded image: a `data:` URL or `{ content_type, base64 }`. Remote URLs are not accepted by Clairic. */
const ImageSchema = z.union([
  z.string().regex(DATA_URL_RE, "an image must be a base64 data: URL of a PNG, JPEG or WebP"),
  z.strictObject({ content_type: z.enum(IMAGE_TYPES), base64: z.string().min(1) }),
]);

type ExtractionImage = z.infer<typeof ImageSchema>;

/** Decoded size of one image, from its base64 length. */
function imageBytes(image: ExtractionImage): number {
  const base64 = (
    typeof image === "string" ? (DATA_URL_RE.exec(image)?.[2] ?? "") : image.base64
  ).replace(/\s+/g, "");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export const SystemOneExtractionConfigSchema = z
  .strictObject({
    provider: z.enum(SYSTEM_ONE_EXTRACT_PROVIDER_IDS).default(SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER),
    /** Provider-specific model id. Unset means the provider's default. */
    model: z.string().min(1).optional(),
    /** The text to read. A structured value is sent as JSON text. May be empty when images are sent. */
    state: z
      .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
      .default(""),
    images: z.array(ImageSchema).max(MAX_IMAGES).optional(),
    /** Anchors dates written without a year. */
    referenceDate: z
      .string()
      .regex(ISO_DATE_RE, "referenceDate must be an ISO date (YYYY-MM-DD)")
      .optional(),
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
    fields: z.record(
      z.string().regex(FIELD_ID_RE, FIELD_ID_MESSAGE),
      SystemOneExtractionFieldSchema,
    ),
  })
  .superRefine((config, ctx) => {
    const fieldIds = Object.keys(config.fields);
    if (fieldIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["fields"],
        message: "system-one-extraction needs at least one field",
      });
    }
    for (const id of fieldIds) {
      if (RESERVED_FIELD_IDS.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["fields", id],
          message: `"${id}" is reserved and cannot be a field id`,
        });
      }
    }
    const stateText = typeof config.state === "string" ? config.state : "nonempty";
    if (stateText.trim() === "" && !config.images?.length) {
      ctx.addIssue({
        code: "custom",
        path: ["state"],
        message: "state must not be empty unless images are sent",
      });
    }
    const images = config.images ?? [];
    let total = 0;
    images.forEach((image, index) => {
      const bytes = imageBytes(image);
      total += bytes;
      if (bytes > MAX_IMAGE_BYTES) {
        ctx.addIssue({
          code: "custom",
          path: ["images", index],
          message: "an image must be at most 4 MiB decoded",
        });
      }
    });
    if (total > MAX_IMAGES_TOTAL_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["images"],
        message: "images must total at most 8 MiB decoded",
      });
    }
    const host: SystemOneHost = SYSTEM_ONE_HOSTS[config.provider];
    const service = host.extract;
    const modelProblem = systemOneModelProblem(
      config.provider,
      config.model ?? service?.defaultModel,
      "extract",
    );
    if (modelProblem) ctx.addIssue({ code: "custom", path: ["model"], message: modelProblem });
    const maxFields = service?.limits?.maxFields;
    if (maxFields !== undefined && fieldIds.length > maxFields) {
      ctx.addIssue({
        code: "custom",
        path: ["fields"],
        message: `SystemOne provider "${config.provider}" takes at most ${maxFields} fields per node; this node has ${fieldIds.length}.`,
      });
    }
    const maxImages = service?.limits?.maxImages;
    if (maxImages !== undefined && images.length > maxImages) {
      ctx.addIssue({
        code: "custom",
        path: ["images"],
        message: `SystemOne provider "${config.provider}" takes at most ${maxImages} images per node.`,
      });
    }
  });

export type SystemOneExtractionConfig = z.infer<typeof SystemOneExtractionConfigSchema>;

// ─── Output schema ──────────────────────────────────────────

const UnitInterval = z.number().min(0).max(1);
const Span = z.tuple([z.number().int().min(0), z.number().int().min(0)]);
/** A number, or an ISO date for a date estimate. */
const Point = z.union([z.number(), z.string()]);

/**
 * One field's answer. `value` is null when the input does not determine it; `guess`
 * is what the model would have said anyway, and `p_null` how likely "no value" is.
 * Estimates add `median`, `p10`, `p90`; forecasts carry one entry per step in each.
 */
export const SystemOneExtractionAnswerSchema = z.strictObject({
  type: z.enum(EXTRACTION_FIELD_TYPES),
  value: z.unknown(),
  guess: z.unknown().optional(),
  p_null: UnitInterval.optional(),
  confidence: UnitInterval.optional(),
  /** `[start, end)` character offsets of the answer in `state`. */
  span: Span.optional(),
  /** One span per list item. */
  spans: z.array(Span).optional(),
  unit: z.string().optional(),
  mean: z.union([Point, z.array(Point)]).optional(),
  median: z.union([Point, z.array(Point)]).optional(),
  p10: z.union([Point, z.array(Point)]).optional(),
  p90: z.union([Point, z.array(Point)]).optional(),
  p_below: UnitInterval.optional(),
  p_above: UnitInterval.optional(),
});

export const SystemOneExtractionOutputSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), SystemOneExtractionAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }),
  /** The host reports whether the state was cut to fit its context. */
  truncated: z.boolean().optional(),
  requestId: z.string().optional(),
});

export type SystemOneExtractionAnswer = z.infer<typeof SystemOneExtractionAnswerSchema>;
export type SystemOneExtractionOutput = z.infer<typeof SystemOneExtractionOutputSchema>;

// ─── Engine-facing rules (authoring + runtime) ──────────────

function hasToken(value: unknown): boolean {
  if (typeof value === "string") return value.includes("{{") && value.includes("}}");
  if (Array.isArray(value)) return value.some(hasToken);
  if (isRecord(value)) return Object.values(value).some(hasToken);
  return false;
}

/**
 * Save-time checks for a field spec that carries a {{token}}. The generic config
 * check skips any issue whose value holds a token, which would let a whole spec
 * (and its field id) through because its `instructions` is templated. Only a
 * string `instructions` may hold a token, so the field id, the spec object and
 * every other option must be literals, and the rest is checked as is.
 */
function templatedFieldViolations(nodeId: string, fields: Record<string, unknown>): string[] {
  const violations: string[] = [];
  for (const [id, spec] of Object.entries(fields)) {
    if (!hasToken(spec)) continue;
    const at = `Node "${nodeId}" (system-one-extraction) config.fields.${id}`;
    if (!FIELD_ID_RE.test(id)) {
      violations.push(`${at}: ${FIELD_ID_MESSAGE}`);
    } else if (RESERVED_FIELD_IDS.has(id)) {
      violations.push(`${at}: "${id}" is reserved and cannot be a field id`);
    }
    if (!isRecord(spec)) {
      violations.push(
        `${at} must be an object: field types and options are static, only instructions may use {{tokens}}`,
      );
      continue;
    }
    const tokened = Object.keys(spec).filter(
      (key) => key !== "instructions" && hasToken(spec[key]),
    );
    for (const key of tokened) {
      violations.push(`${at}.${key} must be a literal: only instructions may use {{tokens}}`);
    }
    if (tokened.length > 0) continue;
    if (typeof spec.instructions !== "string") {
      violations.push(`${at}.instructions must be a string to use {{tokens}}`);
      continue;
    }
    const parsed = SystemOneExtractionFieldSchema.safeParse({ ...spec, instructions: "x" });
    if (parsed.success) continue;
    for (const issue of parsed.error.issues) {
      const path = issue.path.length > 0 ? `${at}.${issue.path.map(String).join(".")}` : at;
      violations.push(`${path}: ${issue.message}`);
    }
  }
  return violations;
}

/** A 3-byte PNG data URL that stands in for a templated image. */
const STAND_IN_IMAGE = "data:image/png;base64,AAAA";

/**
 * The config with every {{token}} replaced by a value the schema accepts:
 * templated known options are dropped (each is optional or has a default),
 * templated `state` and `instructions` become text, and templated images become
 * one small image. Unknown keys stay, so the strict schema still refuses them.
 */
function standInConfig(config: Record<string, unknown>): Record<string, unknown> {
  const known = new Set(Object.keys(SystemOneExtractionConfigSchema.shape));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!hasToken(value) || key === "fields" || !known.has(key)) {
      out[key] = value;
    } else if (key === "state") {
      out.state = typeof value === "string" ? "x" : value;
    } else if (key === "images" && Array.isArray(value)) {
      out.images = value.map((image) => (hasToken(image) ? STAND_IN_IMAGE : image));
    }
  }
  if (isRecord(config.fields)) {
    out.fields = Object.fromEntries(
      Object.entries(config.fields).map(([id, spec]) => [
        id,
        isRecord(spec) && hasToken(spec) ? { ...spec, instructions: "x" } : spec,
      ]),
    );
  }
  return out;
}

/**
 * Whole-config rules hidden by a {{token}}. The generic config check skips an
 * issue whose value holds a token, so a limit on `fields`, `images` or the
 * config itself (field count, image count, unknown keys) disappears once any
 * part of it is templated. Parse the config with type-valid stand-ins and
 * report exactly those issues.
 */
function templatedConfigViolations(nodeId: string, config: Record<string, unknown>): string[] {
  if (!hasToken(config)) return [];
  const parsed = SystemOneExtractionConfigSchema.safeParse(standInConfig(config));
  if (parsed.success) return [];
  const violations: string[] = [];
  for (const issue of parsed.error.issues) {
    let value: unknown = config;
    for (const segment of issue.path) {
      value = isRecord(value) || Array.isArray(value) ? (value as never)[segment] : undefined;
    }
    // A token-free value is reported by the generic check; a token itself resolves at run time.
    if (!hasToken(value) || typeof value === "string") continue;
    const path = ["config", ...issue.path.map(String)].join(".");
    violations.push(`Node "${nodeId}" (system-one-extraction) ${path}: ${issue.message}`);
  }
  return violations;
}

/** Static-shape rules a per-field schema cannot express: field ids and types, and the provider, are static. */
export function systemOneExtractionStaticShapeViolations(node: {
  id: string;
  type: string;
  config: Record<string, unknown>;
}): string[] {
  if (node.type !== SYSTEM_ONE_EXTRACTION_NODE_TYPE) return [];
  const violations: string[] = [];
  const fields = node.config.fields;
  if (
    fields !== undefined &&
    (typeof fields !== "object" || fields === null || Array.isArray(fields))
  ) {
    violations.push(
      `Node "${node.id}" (system-one-extraction) config.fields must be an object: field ids and types are static, only state, images, and instructions may use {{tokens}}`,
    );
  } else if (fields !== undefined) {
    violations.push(...templatedFieldViolations(node.id, fields as Record<string, unknown>));
  }
  const provider = node.config.provider;
  if (typeof provider === "string" && provider.includes("{{")) {
    violations.push(
      `Node "${node.id}" (system-one-extraction) config.provider must be a literal (${SYSTEM_ONE_EXTRACT_PROVIDER_IDS.join(", ")}), not a {{token}}: the provider decides which credential is checked before the run starts`,
    );
  }
  if (violations.length === 0) {
    violations.push(...templatedConfigViolations(node.id, node.config));
  }
  return violations;
}

// ─── Answer validation ──────────────────────────────────────

class ExtractionContractError extends Error {}

function fail(message: string): never {
  throw new ExtractionContractError(message);
}

function unitOrUndefined(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${what} must be a finite number between 0 and 1`);
  }
  return value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSpan(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => Number.isInteger(n) && n >= 0) &&
    value[0] <= value[1]
  );
}

/** A number, or a string for a date estimate: the shape a point of an estimate takes. */
function isPoint(value: unknown, dates: boolean): boolean {
  return dates ? typeof value === "string" : isFiniteNumber(value);
}

/** Check a scalar value against its field. Null means "not in the input" and is always allowed. */
function checkScalar(at: string, field: SystemOneExtractionField, value: unknown): void {
  if (value === null) return;
  switch (field.type) {
    case "text":
    case "date":
    case "time":
    case "datetime":
      if (typeof value !== "string") fail(`${at}.value must be a string or null`);
      return;
    case "number":
    case "duration":
      if (!isFiniteNumber(value)) fail(`${at}.value must be a finite number or null`);
      if (field.integer && !Number.isInteger(value)) fail(`${at}.value must be an integer`);
      return;
    default:
      return;
  }
}

/** Check one raw answer against its declared field. Extra provider fields are dropped. */
function validateAnswer(
  id: string,
  field: SystemOneExtractionField,
  raw: unknown,
): SystemOneExtractionAnswer {
  const at = `answer "${id}"`;
  if (!isRecord(raw)) fail(`${at} must be an object`);
  if (raw.type !== field.type) {
    fail(`${at} has type ${JSON.stringify(raw.type)} but the field declares "${field.type}"`);
  }
  if (!Object.hasOwn(raw, "value")) fail(`${at} is missing its value`);
  const answer: SystemOneExtractionAnswer = { type: field.type, value: raw.value };

  switch (field.type) {
    case "list": {
      if (!Array.isArray(raw.value)) fail(`${at}.value must be a list`);
      const ok = raw.value.every((item) =>
        field.items === "number" ? isFiniteNumber(item) : typeof item === "string",
      );
      if (!ok)
        fail(`${at}.value items must all be ${field.items === "number" ? "numbers" : "strings"}`);
      if (raw.spans !== undefined) {
        if (!Array.isArray(raw.spans) || !raw.spans.every(isSpan)) {
          fail(`${at}.spans must be a list of [start, end] offsets`);
        }
        answer.spans = raw.spans as [number, number][];
      }
      break;
    }
    case "estimate": {
      const dates = typeof field.min === "string";
      if (raw.value !== null && !isPoint(raw.value, dates)) {
        fail(`${at}.value must be ${dates ? "an ISO date" : "a finite number"} or null`);
      }
      for (const key of ["median", "p10", "p90"] as const) {
        if (!isPoint(raw[key], dates))
          fail(`${at}.${key} must be ${dates ? "an ISO date" : "a finite number"}`);
        answer[key] = raw[key] as number | string;
      }
      if (raw.mean !== undefined && isPoint(raw.mean, dates))
        answer.mean = raw.mean as number | string;
      break;
    }
    case "forecast": {
      const steps = (value: unknown) => Array.isArray(value) && value.every(isFiniteNumber);
      if (!steps(raw.value)) fail(`${at}.value must be a list of numbers, one per step`);
      const length = (raw.value as number[]).length;
      if (field.horizon !== undefined && length !== field.horizon) {
        fail(`${at}.value must have ${field.horizon} step(s), got ${length}`);
      }
      for (const key of ["median", "p10", "p90"] as const) {
        if (!steps(raw[key]) || (raw[key] as number[]).length !== length) {
          fail(`${at}.${key} must be a list of ${length} number(s)`);
        }
        answer[key] = raw[key] as number[];
      }
      break;
    }
    default:
      checkScalar(at, field, raw.value);
      if (raw.span !== undefined) {
        if (!isSpan(raw.span)) fail(`${at}.span must be [start, end] offsets`);
        answer.span = raw.span;
      }
      if (raw.guess !== undefined && raw.guess !== null) {
        checkScalar(`${at}.guess`, field, raw.guess);
        answer.guess = raw.guess;
      }
  }

  const pNull = unitOrUndefined(raw.p_null, `${at}.p_null`);
  if (pNull !== undefined) answer.p_null = pNull;
  const confidence = unitOrUndefined(raw.confidence, `${at}.confidence`);
  if (confidence !== undefined) answer.confidence = confidence;
  if (field.type === "estimate") {
    const below = unitOrUndefined(raw.p_below, `${at}.p_below`);
    const above = unitOrUndefined(raw.p_above, `${at}.p_above`);
    if (below !== undefined) answer.p_below = below;
    if (above !== undefined) answer.p_above = above;
  }
  if (typeof raw.unit === "string" && raw.unit !== "") answer.unit = raw.unit;
  return answer;
}

/**
 * Turn a parsed provider body into the node output, or throw. Success requires
 * exactly one valid answer per declared field. Nothing is synthesized or normalized.
 */
export function validateSystemOneExtraction(
  fields: Record<string, SystemOneExtractionField>,
  body: unknown,
  requestId?: string,
): SystemOneExtractionOutput {
  if (!isRecord(body)) fail("response body must be a JSON object");
  if (typeof body.model !== "string" || body.model === "") {
    fail("response is missing the model that produced the answers");
  }
  if (!isRecord(body.answers)) fail("response is missing the answers object");
  const usage = z
    .object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) })
    .safeParse(body.usage);
  if (!usage.success) {
    fail("response usage must report non-negative integer input_tokens and output_tokens");
  }

  const declared = Object.keys(fields);
  if (declared.length === 0) fail("a system-one-extraction call needs at least one field");
  const unexpected = Object.keys(body.answers).filter((id) => !Object.hasOwn(fields, id));
  if (unexpected.length > 0) {
    fail(`response contains ${unexpected.length} answer(s) for undeclared fields`);
  }

  const answers: Record<string, SystemOneExtractionAnswer> = {};
  for (const id of declared) {
    if (!Object.hasOwn(body.answers, id)) fail(`response is missing the answer for field "${id}"`);
    const field = fields[id];
    if (!field) fail(`field "${id}" is not defined`);
    answers[id] = validateAnswer(id, field, body.answers[id]);
  }

  return {
    model: body.model,
    answers,
    usage: usage.data,
    ...(typeof body.truncated === "boolean" ? { truncated: body.truncated } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

// ─── Executor ───────────────────────────────────────────────

export interface SystemOneExtractionExecutorOptions extends SystemOneTransportOptions {
  /** Credential lookup. Defaults to the provider's own source (see `SYSTEM_ONE_HOSTS`). */
  getApiKey?: (provider: SystemOneExtractProviderId) => Promise<string | null | undefined>;
  /** Lookup of the config value the endpoint is built from (Cloudflare's account id). */
  getServerUrl?: (provider: SystemOneExtractProviderId) => Promise<string | null | undefined>;
  env?: NodeJS.ProcessEnv;
}

export class SystemOneExtractionExecutor extends BaseExecutor<
  typeof SystemOneExtractionConfigSchema,
  typeof SystemOneExtractionOutputSchema
> {
  readonly type = SYSTEM_ONE_EXTRACTION_NODE_TYPE;
  readonly mode = "instant" as const;
  readonly configSchema = SystemOneExtractionConfigSchema;
  readonly outputSchema = SystemOneExtractionOutputSchema;

  constructor(
    deps: ExecutorDependencies,
    private readonly options: SystemOneExtractionExecutorOptions = {},
  ) {
    super(deps);
  }

  private providerContext() {
    return { db: this.deps.db, env: this.options.env ?? process.env };
  }

  private resolveTarget(id: SystemOneExtractProviderId, model?: string) {
    const { getApiKey, getServerUrl } = this.options;
    return resolveSystemOneTarget(id, this.providerContext(), {
      apiKey: getApiKey ? () => getApiKey(id) : undefined,
      serverUrl: getServerUrl ? () => getServerUrl(id) : undefined,
      model,
      capability: "extract",
    });
  }

  /** One problem per provider the given nodes use whose credential or endpoint is not usable. */
  override async checkReadiness(
    nodes: readonly ExecutorReadinessNode[],
  ): Promise<ExecutorReadinessProblem[]> {
    const nodeIdsByProvider = new Map<SystemOneExtractProviderId, string[]>();
    for (const node of nodes) {
      // An unknown provider is a config error the schema reports; it names no credential.
      const id = systemOneExtractProviderOf(node.config);
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
    config: SystemOneExtractionConfig,
    _context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<SystemOneExtractionOutput>> {
    const extracted = await this.extract(config);
    return extracted.ok
      ? { status: "success", output: extracted.output }
      : { status: "failed", error: extracted.error };
  }

  /** One extraction: resolve the target, send, validate. The credential stays in this process. */
  async extract(
    config: SystemOneExtractionConfig,
  ): Promise<{ ok: true; output: SystemOneExtractionOutput } | { ok: false; error: string }> {
    const providerId = config.provider;
    const service = (SYSTEM_ONE_HOSTS[providerId] as SystemOneHost).extract;
    if (!service) {
      return { ok: false, error: `SystemOne provider "${providerId}" does not serve extraction` };
    }

    const model = config.model ?? service.defaultModel;
    const modelProblem = systemOneModelProblem(providerId, model, "extract");
    if (modelProblem) return { ok: false, error: modelProblem };
    const target = await this.resolveTarget(providerId, model);
    if (!target.ok) return { ok: false, error: target.error };
    const { apiKey, endpoint, keyName } = target;

    const body = JSON.stringify(service.wire.buildRequest(config, model));
    const scrub = (message: string) => message.split(apiKey).join("[REDACTED]");
    const sent = await sendSystemOneRequest(
      {
        providerId,
        capability: "extract",
        endpoint,
        apiKey,
        keyName,
        body,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        env: this.providerContext().env,
      },
      this.options,
    );
    if (!sent.ok) return { ok: false, error: scrub(sent.error) };

    let parsed: unknown;
    try {
      parsed = JSON.parse(sent.text);
    } catch {
      return { ok: false, error: "SystemOne response was not valid JSON" };
    }
    try {
      return {
        ok: true,
        output: validateSystemOneExtraction(
          config.fields,
          service.wire.toExtraction(parsed),
          sent.requestId,
        ),
      };
    } catch (err) {
      const withId = (message: string) =>
        sent.requestId ? `${message} [request ${sent.requestId}]` : message;
      if (err instanceof SystemOneWireError)
        return { ok: false, error: scrub(withId(err.message)) };
      if (err instanceof ExtractionContractError) {
        return { ok: false, error: scrub(withId(`${VALIDATION_PREFIX}${err.message}`)) };
      }
      throw err;
    }
  }
}
