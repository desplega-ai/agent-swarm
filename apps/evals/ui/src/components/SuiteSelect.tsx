import type { ReactNode } from "react";
import type { SuitesResponse } from "../lib/suite-analytics.ts";

/** "1.0 (current) · 109 attempts", or "· no attempts yet" for a suite nobody ran. */
export function suiteLabel(suites: SuitesResponse, version: string): string {
  const s = suites.suites.find((x) => x.suiteVersion === version);
  const current = version === suites.current ? " (current)" : "";
  return s
    ? `${version}${current} · ${s.attempts} attempts`
    : `${version}${current} · no attempts yet`;
}

/**
 * Suite version picker shared by the Leaderboard views. Every chart on those views
 * is scoped to one suite version, so the choice lives in the hash query and each
 * view reads it back from there.
 */
export function SuiteSelect(props: {
  suites: SuitesResponse | null;
  /** The suite in use, whether picked or defaulted; null until known. */
  value: string | null;
  onChange: (version: string) => void;
}): ReactNode {
  const { suites, value } = props;
  return (
    <label className="lb-field">
      <span className="dim">Suite</span>
      <select
        className="lb-select"
        value={value ?? ""}
        disabled={suites === null}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {suites !== null
          ? [
              ...new Set([
                suites.current,
                ...suites.suites.map((s) => s.suiteVersion),
                ...(value === null ? [] : [value]),
              ]),
            ].map((v) => (
              <option key={v} value={v}>
                {suiteLabel(suites, v)}
              </option>
            ))
          : null}
      </select>
    </label>
  );
}
