import { BOOTSTRAP_MAX_CHARS } from "../prompts/base-prompt";

export const SOUL_MD_MAX_CHARS = 10_000;
export const IDENTITY_MD_MAX_CHARS = 10_000;

export const IDENTITY_FIELD_BUDGETS = {
  soulMd: SOUL_MD_MAX_CHARS,
  identityMd: IDENTITY_MD_MAX_CHARS,
  claudeMd: BOOTSTRAP_MAX_CHARS,
  toolsMd: BOOTSTRAP_MAX_CHARS,
} as const;

export type BudgetedIdentityField = keyof typeof IDENTITY_FIELD_BUDGETS;

export interface IdentityFieldBudgetRejection {
  field: BudgetedIdentityField;
  dbSize: number;
  diskSize: number;
  budget: number;
  delta: number;
  reason: string;
}

export type IdentityFieldBudgetResult =
  | { ok: true }
  | ({ ok: false } & IdentityFieldBudgetRejection);

export function checkIdentityFieldBudget({
  field,
  currentValue,
  nextValue,
}: {
  field: BudgetedIdentityField;
  currentValue: string;
  nextValue: string;
}): IdentityFieldBudgetResult {
  const budget = IDENTITY_FIELD_BUDGETS[field];
  if (nextValue.length <= budget || nextValue.length <= currentValue.length) {
    return { ok: true };
  }

  const delta = nextValue.length - currentValue.length;
  const remediation =
    field === "toolsMd"
      ? ` Content past the ${budget}-character cap is already silently dropped at read time, so shrinking that tail loses nothing sessions currently receive. Move durable content into memories and keep pointers to it in this field.`
      : field === "claudeMd"
        ? ` The tail past the ${budget}-character cap is dropped from the base prompt and only reaches harnesses with a native CLAUDE.md loader. Move durable content into memories and keep pointers to it in this field.`
        : " Move durable content into memories and keep pointers to it in this field.";

  return {
    ok: false,
    field,
    dbSize: currentValue.length,
    diskSize: nextValue.length,
    budget,
    delta,
    reason:
      `Update rejected for ${field}: current size ${currentValue.length} characters, ` +
      `budget ${budget} characters, delta ${delta >= 0 ? "+" : ""}${delta} characters.` +
      remediation,
  };
}

export class IdentityFieldBudgetError extends Error {
  constructor(
    readonly rejection: IdentityFieldBudgetRejection,
    readonly dbHash: string,
    readonly diskHash: string,
  ) {
    super(rejection.reason);
    this.name = "IdentityFieldBudgetError";
  }
}
