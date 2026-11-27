/** Worker-safe session facts. Never a deployment-wide catalog update. */
export interface ModelLimits {
  input?: number;
  output?: number;
  context?: number;
}

export interface EffectiveModelLimits extends ModelLimits {
  context: number;
  contextBasis: "explicit" | "configured-input-plus-output" | "input-conservative" | "fallback";
  source: "litellm-model-info" | "operator" | "catalog" | "legacy";
}

export function positiveTokenLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Explicit policy is rejected, not silently clamped, when it exceeds a known ceiling. */
export function effectiveModelLimits(options: {
  explicit?: ModelLimits;
  discovered?: ModelLimits;
  catalog?: ModelLimits;
  semantics?: "conservative" | "input-plus-output";
}): Readonly<EffectiveModelLimits> {
  const { explicit, discovered, catalog } = options;
  for (const field of ["input", "output", "context"] as const) {
    if (explicit?.[field] !== undefined && !positiveTokenLimit(explicit[field])) {
      throw new Error("Invalid explicit model limit");
    }
    if (explicit?.[field] && discovered?.[field] && explicit[field] > discovered[field]) {
      throw new Error("Explicit model limit exceeds known gateway ceiling");
    }
  }
  const facts = discovered ?? catalog;
  const input = explicit?.input ?? facts?.input;
  const output = explicit?.output ?? facts?.output;
  if (
    explicit?.context &&
    discovered?.input &&
    discovered.output &&
    explicit.context > discovered.input + discovered.output
  ) {
    throw new Error("Explicit combined model limit exceeds applicable gateway bounds");
  }
  let context =
    explicit?.context ?? discovered?.context ?? (!discovered ? catalog?.context : undefined);
  let contextBasis: EffectiveModelLimits["contextBasis"] = "explicit";
  if (!context && input) {
    if (options.semantics === "input-plus-output" && output) {
      context = input + output;
      contextBasis = "configured-input-plus-output";
    } else {
      context = input;
      contextBasis = "input-conservative";
    }
  }
  if (!context) {
    context = catalog?.context ?? 200000;
    contextBasis = "fallback";
  }
  if (!explicit?.context && !discovered && catalog?.context) contextBasis = "fallback";
  if (
    !positiveTokenLimit(context) ||
    (explicit?.input && explicit.input > context) ||
    (output && output > context)
  ) {
    throw new Error("Invalid or contradictory effective model limits");
  }
  return Object.freeze({
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
    context,
    contextBasis,
    source: discovered
      ? "litellm-model-info"
      : explicit
        ? "operator"
        : catalog
          ? "catalog"
          : "legacy",
  });
}
