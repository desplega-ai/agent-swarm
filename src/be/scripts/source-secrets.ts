import { findSecretsIn } from "../../utils/secret-scrubber";

/**
 * Executable source is stored and served verbatim (`scripts.source`,
 * `script_versions.source`, `script_runs.source`): redacting it would change
 * what runs, and sealing it would hide reviewed code. So a source that embeds
 * a secret is refused at write instead, before anything runs or persists.
 *
 * Checked: every registered secret value, in each encoded form the known-value
 * matcher holds, and the gitleaks vendor-token rules. The refusal names the
 * secret's key or the rule id, never the value. Rows written before this check
 * are left as they are.
 */
export interface SourceSecretRefusal {
  error: "source_contains_secret";
  message: string;
  findings: { kind: "registered-secret" | "gitleaks-rule"; id: string }[];
}

export function refuseSourceWithSecrets(source: string): SourceSecretRefusal | null {
  const { knownValues, gitleaksRules } = findSecretsIn(source);
  if (knownValues.length === 0 && gitleaksRules.length === 0) return null;
  const findings = [
    ...knownValues.map((id) => ({ kind: "registered-secret" as const, id })),
    ...gitleaksRules.map((id) => ({ kind: "gitleaks-rule" as const, id })),
  ];
  const named = findings
    .map((f) =>
      f.kind === "registered-secret" ? `registered secret ${f.id}` : `gitleaks rule ${f.id}`,
    )
    .join(", ");
  return {
    error: "source_contains_secret",
    message: `Script source contains a secret (${named}); nothing was saved or run. Source is stored and shown verbatim, so read secrets at run time instead: a credential binding (ctx.api.<slug> / ctx.mcp.<slug>) or ctx.swarm.config.get("<KEY>").`,
    findings,
  };
}
