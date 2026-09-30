import { REASONING_EFFORT_LEVELS } from "@desplega/model-catalog";
import type { ReactNode } from "react";
import { Tooltip } from "./Tooltip.tsx";
import "./effort-chip.css";

/**
 * Reasoning effort as a small pill next to a harness and model (ConfigChip,
 * attempt rows). Renders nothing for the harness default, so rows that never
 * set an effort look exactly as before.
 *
 * `applied` is what the attempt's harness reported applying. When it is passed
 * and differs from `effort`, the pill turns amber: the harness ignored the
 * level (a pair that does not take it, or it never reported).
 */
export function EffortChip(props: {
  effort: string | null | undefined;
  /** Pass for attempts: null = the harness reported none. Omit where it does not apply. */
  applied?: string | null;
  dim?: boolean;
}): ReactNode {
  const { effort, applied } = props;
  if (!effort) return null;
  const mismatch = applied !== undefined && applied !== effort;
  const className = [
    "effort-chip",
    `effort-${effort}`,
    mismatch ? "effort-mismatch" : "",
    props.dim ? "dim" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const tip = mismatch
    ? `Reasoning effort ${effort} was requested, but the harness reported ${applied ?? "none"}. It ignored the level.`
    : applied === effort
      ? `Reasoning effort ${effort} — the harness confirmed it applied it`
      : `Reasoning effort ${effort}`;
  return (
    <Tooltip text={tip}>
      <span className={className}>{effort}</span>
    </Tooltip>
  );
}

/** Label for an analytics effort key: the server's `default` key reads "harness default". */
export function effortKeyLabel(key: string): string {
  return key === "default" ? "harness default" : key;
}

/** Effort keys low → high (the catalog's canonical order); unknown values after them, `default` last. */
export function sortEffortKeys(keys: Iterable<string>): string[] {
  const order: readonly string[] = REASONING_EFFORT_LEVELS;
  const rank = (key: string): number =>
    key === "default"
      ? order.length + 1
      : order.indexOf(key) === -1
        ? order.length
        : order.indexOf(key);
  return [...new Set(keys)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
