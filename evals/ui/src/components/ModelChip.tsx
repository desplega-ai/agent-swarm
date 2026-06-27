import type { ReactNode } from "react";
import { useModels } from "../hooks.ts";
import type { ModelJson } from "../types.ts";
import { fmtPerM, fmtTokens } from "./format.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Reusable model rendering (item 18): human display name from models.dev with a
 * hover card carrying the full info (id, pricing, context, capabilities).
 * Unresolved ids gracefully fall back to the raw id.
 */
export function ModelChip(props: { model: string | null; dim?: boolean }): ReactNode {
  const { resolve } = useModels();
  if (props.model === null || props.model.length === 0) {
    return <span className="dim">—</span>;
  }
  const model = resolve(props.model);
  if (!model) {
    return (
      <Tooltip text="Not in the models.dev catalog">
        <code className={props.dim ? "model-chip dim" : "model-chip"}>{props.model}</code>
      </Tooltip>
    );
  }
  return (
    <Tooltip wide text={<ModelCard model={model} />}>
      <span className={props.dim ? "model-chip dim" : "model-chip"}>{model.name}</span>
    </Tooltip>
  );
}

function CardRow(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="tip-card-row">
      <span className="tip-card-label">{props.label}</span>
      <span className="tip-card-value">{props.children}</span>
    </div>
  );
}

function ModelCard(props: { model: ModelJson }): ReactNode {
  const m = props.model;
  return (
    <div className="tip-card">
      <div className="tip-card-title">{m.name}</div>
      <CardRow label="Id">
        <code>{m.id}</code>
      </CardRow>
      <CardRow label="Input">{fmtPerM(m.inputPerM)} / 1M</CardRow>
      <CardRow label="Output">{fmtPerM(m.outputPerM)} / 1M</CardRow>
      {m.cacheReadPerM !== null ? (
        <CardRow label="Cache Read">{fmtPerM(m.cacheReadPerM)} / 1M</CardRow>
      ) : null}
      {m.cacheWritePerM !== null ? (
        <CardRow label="Cache Write">{fmtPerM(m.cacheWritePerM)} / 1M</CardRow>
      ) : null}
      <CardRow label="Context">{fmtTokens(m.context)}</CardRow>
      <CardRow label="Capabilities">
        Reasoning {m.reasoning ? "✓" : "✗"} · Tools {m.toolCall ? "✓" : "✗"}
      </CardRow>
    </div>
  );
}
