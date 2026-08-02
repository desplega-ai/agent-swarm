export type GlobalPromotionPolicyFinding = {
  name: string;
  rule: string;
  evidence: string;
};

export type GlobalPromotionPolicyResult =
  | { ok: true; findings: [] }
  | { ok: false; findings: GlobalPromotionPolicyFinding[] };

const EXEMPT_SCRIPT_NAMES = new Set([
  "install-population-gate-lint",
  "legit-install-population",
  "install-telemetry-profile",
]);

/**
 * Enforce the install-population consumer rules used by the catalog lint.
 * This helper is deliberately pure so every global promotion is checked at
 * the server boundary without depending on a mutable catalog script.
 */
export function lintGlobalScriptPromotion(args: {
  name: string;
  source: string;
}): GlobalPromotionPolicyResult {
  if (EXEMPT_SCRIPT_NAMES.has(args.name)) return { ok: true, findings: [] };

  const lower = args.source.toLowerCase();
  if (!lower.includes("raw_events") || !lower.includes("actor_anonymous_id")) {
    return { ok: true, findings: [] };
  }

  const findings: GlobalPromotionPolicyFinding[] = [];
  const deliberateMarker =
    args.source.includes("Integrity rule 5") &&
    /installs_(events|active_days|server_started|first_event|session_cost|task_events)/.test(
      args.source,
    );
  const helperCall = /name:\s*["']legit-install-population["']/.test(args.source);

  const localPopulationGate =
    /HAVING\s+(?:count|server_count)/i.test(args.source) ||
    /length\s*\(\s*task_days\s*\)\s*>=\s*5/i.test(args.source) ||
    /WHERE\s+server_count\s*>=\s*1/i.test(args.source);
  if (localPopulationGate && !deliberateMarker) {
    findings.push({
      name: args.name,
      rule: "no-local-install-population-gate",
      evidence:
        "local HAVING/server_count/task_days population gate without an explicit deliberate-gate marker",
    });
  }

  const weeklyEventGate = /uniqExactIf\s*\(\s*actor_anonymous_id\s*,\s*c\s*>=/i.test(args.source);
  const helperScopedIds = /actor_anonymous_id\s+IN\s*\(\s*\$\{idList\}\s*\)/i.test(args.source);
  if (weeklyEventGate && !(helperCall && helperScopedIds) && !deliberateMarker) {
    findings.push({
      name: args.name,
      rule: "weekly-event-cut-must-be-helper-scoped-or-explicit",
      evidence:
        "uniqExactIf(actor,c>=N) is not scoped to helper IDs and has no deliberate-gate marker",
    });
  }

  const ambiguousOutput = args.source
    .split("\n")
    .find((line) =>
      /^\s*(installs|totalInstallations|activeInstalls\w*|qualifiedN|installedPopulation)\s*:/.test(
        line,
      ),
    );
  if (ambiguousOutput) {
    findings.push({
      name: args.name,
      rule: "install-output-name-must-state-gate",
      evidence: ambiguousOutput.trim().slice(0, 180),
    });
  }

  if (lower.includes("legit") && !helperCall && !deliberateMarker) {
    findings.push({
      name: args.name,
      rule: "legit-install-consumer-must-call-helper",
      evidence: "source emits/derives legit-install data but has no legit-install-population call",
    });
  }

  return findings.length === 0 ? { ok: true, findings: [] } : { ok: false, findings };
}
