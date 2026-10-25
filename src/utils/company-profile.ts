import type { EventContext } from "../telemetry-contract";

export const COMPANY_TEAM_SIZES = ["1", "2-10", "11-50", "51+"] as const;

export const COMPANY_USE_CASES = [
  "features",
  "bugs",
  "review",
  "ops",
  "docs",
  "data",
  "content",
  "research",
  "seo",
  "admin",
] as const;

export const COMPANY_ACQUISITION_SOURCES = [
  "search",
  "github",
  "social",
  "colleague",
  "newsletter",
  "event",
  "ai_assistant",
  "hacker_news",
  "other",
] as const;

export const USER_FUNCTIONS = [
  "engineer",
  "eng_lead",
  "founder",
  "product",
  "marketing",
  "sales",
  "research",
  "ops",
  "other",
] as const;

// The values the vendored telemetry catalog (`src/telemetry-contract`) lists.
// The proxy rejects a whole event, feedback submission or benchmark request
// for one value it does not list. So a newer value stays out of telemetry, as
// if unset, until the proxy catalog adds it and `sync:telemetry-contract` runs.
const REPORTED_USE_CASES = [
  "features",
  "bugs",
  "review",
  "ops",
  "docs",
  "data",
] as const satisfies readonly NonNullable<EventContext["use_case"]>[];

const REPORTED_USER_FUNCTIONS = [
  "engineer",
  "eng_lead",
  "founder",
  "product",
  "ops",
  "other",
] as const satisfies readonly NonNullable<EventContext["user_function"]>[];

/** `value` when telemetry may report it as a use case, else undefined. */
export function reportedUseCase(value: unknown): (typeof REPORTED_USE_CASES)[number] | undefined {
  return REPORTED_USE_CASES.find((reported) => reported === value);
}

/** `value` when telemetry may report it as a job function, else undefined. */
export function reportedUserFunction(
  value: unknown,
): (typeof REPORTED_USER_FUNCTIONS)[number] | undefined {
  return REPORTED_USER_FUNCTIONS.find((reported) => reported === value);
}
