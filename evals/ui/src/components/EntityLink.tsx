import type { ReactNode } from "react";

/** Backlinking convention: every entity reference is a link. */
export function EntityLink(props: {
  kind: "run" | "scenario" | "attempt" | "config" | "artifact";
  id: string;
  runId?: string; // REQUIRED for kind="attempt"
  label?: string; // default: id (runs display with "run-" prefix stripped)
}): ReactNode {
  const { kind, id, runId } = props;
  const label = props.label ?? (kind === "run" ? id.replace(/^run-/, "") : id);
  switch (kind) {
    case "run":
      return (
        <a className="entity-link" href={`#/runs/${id}`}>
          {label}
        </a>
      );
    case "scenario":
      return (
        <a className="entity-link" href={`#/scenarios/${id}`}>
          {label}
        </a>
      );
    case "attempt":
      return (
        <a className="entity-link" href={`#/runs/${runId}/attempts/${id}`}>
          {label}
        </a>
      );
    case "artifact":
      return (
        <a className="entity-link" href={`/api/artifacts/${id}`} target="_blank" rel="noreferrer">
          {label}
        </a>
      );
    case "config":
      return (
        <a className="entity-link" href={`#/configs/${id}`}>
          {label}
        </a>
      );
  }
}
