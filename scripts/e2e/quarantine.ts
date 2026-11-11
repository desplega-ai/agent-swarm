import { asRecord } from "./http";

/**
 * One quarantined scenario. It still runs and reports, but its failure cannot fail the
 * run. `expires` is a calendar date (YYYY-MM-DD, UTC); from the day after it, the entry
 * itself fails the run, so a quarantine is never forgotten.
 */
export type QuarantineEntry = {
  scenario: string;
  owner: string;
  reason: string;
  expires: string;
};

export const QUARANTINE_PATH = `${import.meta.dir}/quarantine.json`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function field(entry: Record<string, unknown>, name: keyof QuarantineEntry, index: number) {
  const value = entry[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`quarantine.json entry ${index} needs a non-empty "${name}" string`);
  }
  return value;
}

/** Parse quarantine.json. A malformed file throws before anything boots. */
export function parseQuarantine(raw: unknown): QuarantineEntry[] {
  if (!Array.isArray(raw)) throw new Error("quarantine.json must be a JSON array");
  return raw.map((item, index) => {
    const entry = asRecord(item);
    const expires = field(entry, "expires", index);
    if (!DATE.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
      throw new Error(`quarantine.json entry ${index}: expires must be YYYY-MM-DD, got ${expires}`);
    }
    return {
      scenario: field(entry, "scenario", index),
      owner: field(entry, "owner", index),
      reason: field(entry, "reason", index),
      expires,
    };
  });
}

export async function loadQuarantine(path = QUARANTINE_PATH): Promise<QuarantineEntry[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return parseQuarantine(await file.json());
}

/**
 * Reasons the quarantine file itself fails the run: an expired entry, an entry naming no
 * scenario (a typo would quarantine nothing), or a scenario listed twice.
 */
export function quarantineProblems(
  entries: readonly QuarantineEntry[],
  knownScenarios: ReadonlySet<string>,
  today: string,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!knownScenarios.has(entry.scenario)) {
      problems.push(`quarantine entry ${entry.scenario} matches no scenario`);
    }
    if (seen.has(entry.scenario)) problems.push(`quarantine lists ${entry.scenario} twice`);
    seen.add(entry.scenario);
    if (entry.expires < today) {
      problems.push(
        `quarantine for ${entry.scenario} expired on ${entry.expires} (owner ${entry.owner}): fix the scenario or extend the entry`,
      );
    }
  }
  return problems;
}
