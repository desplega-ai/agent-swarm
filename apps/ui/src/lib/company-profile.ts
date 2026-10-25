/**
 * The company profile the dashboard asks for: the canonical answer lists
 * (values match the API validators; telemetry reports only the values its
 * catalog lists, see `src/utils/company-profile.ts`) and the email domain
 * helpers that pre-fill the swarm name and website.
 */
import { z } from "zod";
import { normalizeOrgWebsite, websiteSuggestion } from "../../../../src/utils/org-website";

/** Global `swarm_config` keys. An empty value clears the answer. */
export const SWARM_ORG_TEAM_SIZE = "SWARM_ORG_TEAM_SIZE";
export const SWARM_ORG_USE_CASE = "SWARM_ORG_USE_CASE";
export const SWARM_ORG_ACQUISITION_SOURCE = "SWARM_ORG_ACQUISITION_SOURCE";

export interface ProfileOption<V extends string = string> {
  readonly value: V;
  readonly label: string;
}

export const TEAM_SIZES = [
  { value: "1", label: "Just me" },
  { value: "2-10", label: "2-10" },
  { value: "11-50", label: "11-50" },
  { value: "51+", label: "51+" },
] as const;
export type TeamSize = (typeof TEAM_SIZES)[number]["value"];

/** The two use case groups, in display order. */
export const USE_CASE_GROUPS = [
  { id: "build", label: "Build software" },
  { id: "business", label: "Run the business" },
] as const;

/** Values never change: telemetry and the fleet benchmark compare them across versions. */
export const USE_CASES = [
  { value: "features", label: "Ship features", group: "build" },
  { value: "bugs", label: "Fix bugs", group: "build" },
  { value: "review", label: "Review PRs", group: "build" },
  { value: "ops", label: "Ops and incidents", group: "build" },
  { value: "data", label: "Data work", group: "build" },
  { value: "content", label: "Write content", group: "business" },
  { value: "research", label: "Research and reports", group: "business" },
  { value: "seo", label: "Get found online", group: "business" },
  { value: "docs", label: "Docs and support", group: "business" },
  { value: "admin", label: "Inbox and admin", group: "business" },
] as const;
export type UseCase = (typeof USE_CASES)[number]["value"];

/** "How did you hear about us?" The order biases answers, so a surface may shuffle it. */
export const ACQUISITION_SOURCES = [
  { value: "search", label: "Search" },
  { value: "github", label: "GitHub" },
  { value: "social", label: "X or LinkedIn" },
  { value: "colleague", label: "A colleague" },
  { value: "newsletter", label: "Newsletter or podcast" },
  { value: "event", label: "Event or meetup" },
  { value: "ai_assistant", label: "An AI assistant" },
  { value: "hacker_news", label: "Hacker News" },
  { value: "other", label: "Other" },
] as const;
export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number]["value"];

/** A person's job function, stored in `users.metadata.jobFunction` (never in `users.role`). */
export const USER_FUNCTIONS = [
  { value: "engineer", label: "Engineer" },
  { value: "eng_lead", label: "Engineering lead" },
  { value: "founder", label: "Founder or exec" },
  { value: "product", label: "Product or design" },
  { value: "marketing", label: "Marketing or content" },
  { value: "sales", label: "Sales or success" },
  { value: "research", label: "Research" },
  { value: "ops", label: "Ops or IT" },
  { value: "other", label: "Other" },
] as const;
export type UserFunction = (typeof USER_FUNCTIONS)[number]["value"];

/** `value` when it is one of `options`, else null (unset, or from another API version). */
export function optionValue<V extends string>(
  options: readonly ProfileOption<V>[],
  value: unknown,
): V | null {
  return options.find((option) => option.value === value)?.value ?? null;
}

/** The label of `value` in `options`, or null. */
export function optionLabel(options: readonly ProfileOption[], value: unknown): string | null {
  return options.find((option) => option.value === value)?.label ?? null;
}

/** The name older `/setup` runs stored by default. It counts as unset: the name is required. */
export const OLD_DEFAULT_ORG_NAME = "Your Swarm";

/** A stored `SWARM_ORG_NAME`, trimmed, or null when it is empty or the old default. */
export function storedOrgName(value: string | null | undefined): string | null {
  const name = value?.trim();
  return name && name !== OLD_DEFAULT_ORG_NAME ? name : null;
}

// The same check as the API's `z.string().email()` (`src/http/users.ts`, `src/http/used-by.ts`).
const EMAIL = z.email();

/** Whether the API accepts `email` (trimmed) as an email address. */
export function isValidEmail(email: string): boolean {
  return EMAIL.safeParse(email.trim()).success;
}

/** The lowercase domain of a typed address, or null. */
export function domainOf(email: string): string | null {
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  const domain = value.slice(at + 1);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

/** The company domain of an address, or null for free mail (gmail.com, ...). */
export function companyDomain(email: string): string | null {
  return websiteSuggestion(domainOf(email));
}

/** A public free-mail address (gmail.com, outlook.com, ...): a personal, not a work, email. */
export function isFreemail(email: string): boolean {
  const domain = domainOf(email);
  return normalizeOrgWebsite(domain) !== null && websiteSuggestion(domain) === null;
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);
const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** acme.com becomes Acme, acme-labs.co.uk becomes Acme Labs. */
export function orgNameFromDomain(domain: string): string {
  const labels = domain.split(".");
  const second = labels.at(-2) ?? labels[0];
  const base = labels.length > 2 && SECOND_LEVEL.has(second) ? (labels.at(-3) ?? second) : second;
  return base.split("-").filter(Boolean).map(capitalize).join(" ");
}

/** ada.lovelace@acme.com becomes Ada Lovelace. A plus tag (ada+qa@) is not part of the name. */
export function nameFromEmail(email: string): string {
  const local = (email.trim().split("@")[0] ?? "").split("+")[0];
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map(capitalize)
    .join(" ");
}
