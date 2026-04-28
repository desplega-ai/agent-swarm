// Phase 2: budget admission predicate.
//
// Pure function. Given an `agentId` and the current UTC instant, returns
// either `{ allowed: true }` or a structured refusal envelope with the cause,
// the relevant spend/budget figures, and the next UTC midnight (`resetAt`).
//
// Callers (Phase 3 wires the three V1 gates: /api/poll pre-assigned-pending,
// /api/poll pool, MCP `task-action` `accept`) translate refusals into the
// `budget_refused` trigger envelope.

import { getBudget, getDailySpendForAgent, getDailySpendGlobal } from "./db";

export interface BudgetAdmissionAllowed {
  allowed: true;
}

export interface BudgetAdmissionRefused {
  allowed: false;
  cause: "agent" | "global";
  agentSpend?: number;
  agentBudget?: number;
  globalSpend?: number;
  globalBudget?: number;
  /** ISO 8601 of the next UTC midnight (the moment daily spend rolls over). */
  resetAt: string;
}

export type BudgetAdmissionResult = BudgetAdmissionAllowed | BudgetAdmissionRefused;

/**
 * Operator escape hatch (per Decision #11 in the plan): setting
 * `BUDGET_ADMISSION_DISABLED=true` at process boot unconditionally returns
 * `{ allowed: true }` from `canClaim`. We log a single `console.warn` per
 * process so deploys with the flag still on are visible in logs.
 */
let killSwitchWarned = false;

function dateUtcFrom(now: Date): string {
  // `Date.toISOString()` always emits `'YYYY-MM-DDTHH:MM:SS.sssZ'` in UTC,
  // so the first 10 chars are the UTC calendar day.
  return now.toISOString().slice(0, 10);
}

function nextUtcMidnight(now: Date): string {
  // Build the FOLLOWING UTC midnight by adding one day to the date components.
  // Adding at the date-component level lets `Date.UTC` handle month and year
  // rollovers automatically (e.g. April 30 → May 1, Dec 31 → Jan 1).
  //
  // Edge case: if `now` is itself exactly UTC midnight, this still returns
  // the NEXT midnight (+24h), not the current instant — covered by tests.
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return next.toISOString();
}

/**
 * Decide whether `agentId` is allowed to claim a new task right now. Pure —
 * does not mutate any DB state. Order:
 *   0. Kill-switch (`BUDGET_ADMISSION_DISABLED=true`) ⇒ allowed.
 *   1. Global budget set + global daily spend ≥ ceiling ⇒ refused (`global`).
 *   2. Agent budget set + agent daily spend ≥ ceiling ⇒ refused (`agent`).
 *   3. Otherwise ⇒ allowed.
 *
 * Global is checked first by design: a tripped global budget halts the entire
 * swarm regardless of any single agent's spend.
 */
export function canClaim(agentId: string, nowUtc: Date): BudgetAdmissionResult {
  if (process.env.BUDGET_ADMISSION_DISABLED === "true") {
    if (!killSwitchWarned) {
      killSwitchWarned = true;
      console.warn(
        "[budget-admission] BUDGET_ADMISSION_DISABLED=true — all canClaim() calls will return allowed for the lifetime of this process.",
      );
    }
    return { allowed: true };
  }

  const dateUtc = dateUtcFrom(nowUtc);
  const resetAt = nextUtcMidnight(nowUtc);

  // 1. Global budget gate.
  const globalBudget = getBudget("global", "");
  if (globalBudget !== null) {
    const globalSpend = getDailySpendGlobal(dateUtc);
    if (globalSpend >= globalBudget.dailyBudgetUsd) {
      return {
        allowed: false,
        cause: "global",
        globalSpend,
        globalBudget: globalBudget.dailyBudgetUsd,
        resetAt,
      };
    }
  }

  // 2. Per-agent budget gate.
  const agentBudget = getBudget("agent", agentId);
  if (agentBudget !== null) {
    const agentSpend = getDailySpendForAgent(agentId, dateUtc);
    if (agentSpend >= agentBudget.dailyBudgetUsd) {
      return {
        allowed: false,
        cause: "agent",
        agentSpend,
        agentBudget: agentBudget.dailyBudgetUsd,
        resetAt,
      };
    }
  }

  return { allowed: true };
}

/**
 * Test-only: reset the kill-switch warning latch so the warning fires fresh
 * in subsequent test cases. Not intended for production use.
 */
export function __resetKillSwitchWarnedForTests(): void {
  killSwitchWarned = false;
}
