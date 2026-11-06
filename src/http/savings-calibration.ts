import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getSwarmConfigs, upsertSwarmConfig } from "../be/db";
import type { DbParam } from "../be/db-client";
import { calibrate, type DerivedCurveSet } from "../be/savings/calibrate";
import type { SavingsSql } from "../be/savings/compute";
import {
  type CurveSet,
  SAVINGS_CALIBRATION_KEY,
  SAVINGS_TIERS,
  SHIPPED_CALIBRATION,
  StoredCalibrationSchema,
} from "../be/savings/model";
import { ensureConfigAdmin } from "./config";
import { DbQueryConcurrencyCapError, DbQueryTimeoutError } from "./db-query-shared";
import { route } from "./route-def";
import { boundedSql, clearCalibrationCache } from "./savings";
import { json, jsonError } from "./utils";

/** A run that has not finished by now is abandoned with a 504. */
const DEADLINE_MS = 120_000;
let deadlineMs = DEADLINE_MS;
let running = false;

/** Test hook: shrink the deadline. */
export function setCalibrationDeadlineMs(ms: number | null): void {
  deadlineMs = ms ?? DEADLINE_MS;
}

class DeadlineError extends Error {}

const plain = (c: CurveSet): DerivedCurveSet =>
  Object.fromEntries(
    SAVINGS_TIERS.map((t) => [t, { usd: [...c[t].usd], hrs: [...c[t].hrs] }]),
  ) as DerivedCurveSet;

/**
 * `boundedSql` (child process, per-query budget, shared concurrency cap) under one
 * wall-clock deadline for the whole run. A full concurrency cap is waited out, not read as empty.
 */
function deadlineSql(deadlineAt: number): SavingsSql {
  return async <T>(sql: string, params: DbParam[]) => {
    for (let attempt = 0; ; attempt++) {
      const left = deadlineAt - Date.now();
      if (left <= 0) throw new DeadlineError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const query = boundedSql<T>(sql, params);
      query.catch(() => {}); // an abandoned query's late failure is not an unhandled rejection
      try {
        return await Promise.race([
          query,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new DeadlineError()), left);
          }),
        ]);
      } catch (err) {
        if (!(err instanceof DbQueryConcurrencyCapError)) throw err;
        await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** attempt, 2000)));
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

const TierCurvesSchema = z.object({ usd: z.array(z.number()), hrs: z.array(z.number()) });
const CurveSetSchema = z.object(
  Object.fromEntries(SAVINGS_TIERS.map((t) => [t, TierCurvesSchema])) as Record<
    (typeof SAVINGS_TIERS)[number],
    typeof TierCurvesSchema
  >,
);
const WindowSchema = z.object({ start: z.string(), end: z.string(), sessions: z.number().int() });

const StoredSchema = z.object({
  calibratedAt: z.string(),
  model: z.string(),
  curve: CurveSetSchema,
  window: WindowSchema.optional(),
});

const GapSchema = z.object({
  tier: z.enum(SAVINGS_TIERS),
  key: z.enum(["usd", "hrs"]),
  median: z.number().describe("Median absolute deviation from the shipped curve, as a fraction."),
  max: z.number(),
  over5pct: z.number().int().describe("Turn counts more than 5% from the shipped curve."),
  points: z.number().int(),
  weighted: z
    .number()
    .describe("Session-weighted mean of derived over shipped; 1 means the same price."),
});

const getRoute = route({
  method: "get",
  path: "/api/savings/calibration",
  pattern: ["api", "savings", "calibration"],
  summary: "The savings curve in use",
  description:
    "Which curve prices the savings endpoints: the one shipped with the release, or one derived from this deployment's sessions and stored by `POST /api/savings/calibration`. Reports the stored row's metadata (a malformed row is reported as invalid and ignored by the savings endpoints).",
  tags: ["Savings"],
  responses: {
    200: {
      description: "The active calibration",
      schema: z.object({
        source: z.enum(["shipped", "deployment"]),
        active: StoredSchema.omit({ window: true }),
        stored: z
          .object({
            valid: z.boolean(),
            updatedAt: z.string(),
            calibratedAt: z.string().optional(),
            model: z.string().optional(),
            window: WindowSchema.optional(),
          })
          .nullable(),
      }),
    },
  },
});

const postRoute = route({
  method: "post",
  path: "/api/savings/calibration",
  pattern: ["api", "savings", "calibration"],
  summary: "Derive the savings curve from this deployment's sessions",
  description:
    "Reads the window's opus sessions through the bounded query executor, derives the per-tier cost and hours curve, and compares it to the shipped one. Read-only unless `apply` is true, which also requires `config.write.any`: then the curve is stored in the global `SAVINGS_CURVE_CALIBRATION` config row and the savings endpoints use it within seconds. Nothing is stored when the data cannot support a curve or the derived mean cost is more than 3x or less than a third of the shipped one. One run at a time; a run past 120 s is abandoned with 504.",
  tags: ["Savings"],
  body: z.object({
    days: z.number().int().min(1).max(90).default(30),
    end: z.iso.datetime().optional().describe("End of the window (ISO 8601); default now."),
    apply: z.boolean().default(false),
  }),
  responses: {
    200: {
      description: "The derived curve, or why there is none",
      schema: z.object({
        window: z.object({ start: z.string(), end: z.string(), days: z.number().int() }),
        sessions: z.number().int().describe("Opus sessions of 1 to 61 turns used."),
        refusals: z
          .array(z.string())
          .describe("Why no curve was derived, or why a derived one was not applied."),
        calibration: StoredSchema.nullable().describe("The derived curve; null when refused."),
        speed: z.record(z.string(), z.number()).nullable(),
        repriceMatch: z.number().nullable(),
        meanRatio: z
          .number()
          .nullable()
          .describe("Derived smart-tier mean cost over the shipped one."),
        gaps: z.array(GapSchema),
        applied: z.boolean(),
      }),
    },
    400: { description: "Invalid days, end or apply" },
    403: { description: "`apply` without permission to write config" },
    408: { description: "A session query ran past its time budget" },
    409: { description: "Another calibration run is in progress" },
    504: { description: "The run passed its 120 s deadline" },
  },
  rbac: {
    ungated:
      "a dry run only reads sessions; apply:true is gated by config.write.any in the handler",
  },
});

export async function handleSavingsCalibration(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (getRoute.match(req.method, pathSegments)) {
    const [row] = await getSwarmConfigs({ scope: "global", key: SAVINGS_CALIBRATION_KEY });
    let parsed: z.infer<typeof StoredCalibrationSchema> | null = null;
    try {
      const result = StoredCalibrationSchema.safeParse(JSON.parse(row?.value ?? "null"));
      parsed = result.success ? result.data : null;
    } catch {
      // malformed JSON: reported below as an invalid row
    }
    const active = parsed ?? { ...SHIPPED_CALIBRATION, curve: plain(SHIPPED_CALIBRATION.curve) };
    getRoute.respond(res, 200, {
      source: parsed ? "deployment" : "shipped",
      active: { calibratedAt: active.calibratedAt, model: active.model, curve: active.curve },
      stored: row
        ? {
            valid: parsed !== null,
            updatedAt: row.lastUpdatedAt,
            ...(parsed
              ? {
                  calibratedAt: parsed.calibratedAt,
                  model: parsed.model,
                  ...(parsed.window ? { window: parsed.window } : {}),
                }
              : {}),
          }
        : null,
    });
    return true;
  }

  if (!postRoute.match(req.method, pathSegments)) return false;
  const parsed = await postRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  const { days, end, apply } = parsed.body;
  if (apply && !(await ensureConfigAdmin(req, res, "config.write.any"))) return true;
  if (running) {
    jsonError(res, "A calibration run is already in progress", 409);
    return true;
  }
  running = true;
  try {
    const run = await calibrate(deadlineSql(Date.now() + deadlineMs), {
      days,
      end: end ? new Date(end) : new Date(),
    });
    const refusals = run.refusal ? [run.refusal] : [];
    let applied = false;
    if (apply && run.calibration) {
      if (run.applyBlocked) {
        refusals.push(`not applied: ${run.applyBlocked}`);
      } else {
        StoredCalibrationSchema.parse(run.calibration);
        await upsertSwarmConfig({
          scope: "global",
          key: SAVINGS_CALIBRATION_KEY,
          value: JSON.stringify(run.calibration),
          // Read by the API only; keep the ~9 KB blob out of every agent's environment.
          exportToEnv: false,
          description: "Savings session curve derived from this deployment's sessions",
        });
        clearCalibrationCache();
        applied = true;
      }
    }
    postRoute.respond(res, 200, {
      window: run.window,
      sessions: run.sessions,
      refusals,
      calibration: run.calibration,
      speed: run.speed,
      repriceMatch: run.repriceMatch,
      meanRatio: run.meanRatio,
      gaps: run.gaps,
      applied,
    });
  } catch (err) {
    if (err instanceof DeadlineError) {
      jsonError(
        res,
        `Calibration passed its ${deadlineMs / 1000} s deadline; use a shorter window`,
        504,
      );
    } else if (err instanceof DbQueryTimeoutError) {
      json(res, { error: "db_query_timeout", message: err.message }, 408);
    } else {
      throw err;
    }
  } finally {
    running = false;
  }
  return true;
}
