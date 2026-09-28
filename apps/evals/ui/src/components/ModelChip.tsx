import type { ReactNode } from "react";
import { useModels } from "../hooks.ts";
import type { ModelJson } from "../types.ts";
import { fmtPerM, fmtTokens } from "./format.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Reusable model rendering (item 18): human display name from models.dev with a
 * hover card carrying the full info (id, pricing, context, capabilities).
 * Unresolved ids gracefully fall back to the raw id.
 *
 * `alias` marks a moving `latest:…` alias config: pass the id it resolves to as
 * `model` (null when it matches nothing today). The resolved model is the label
 * and the alias sits in the hover card, so an alias is never reported as
 * "not in the catalog".
 */
export function ModelChip(props: {
  model: string | null;
  alias?: string | null;
  dim?: boolean;
}): ReactNode {
  const { resolve } = useModels();
  const className = props.dim ? "model-chip dim" : "model-chip";
  const alias = props.alias ?? null;
  const hasModel = props.model !== null && props.model.length > 0;
  if (!hasModel) {
    if (alias === null) return <span className="dim">—</span>;
    return (
      <Tooltip text={`Moving alias ${alias} matches no model in the current catalog`}>
        <code className={className}>{alias}</code>
      </Tooltip>
    );
  }
  const modelId = props.model as string;
  const model = resolve(modelId);
  if (!model) {
    return (
      <Tooltip text={alias ? `${alias} resolves to ${modelId}` : "Not in the models.dev catalog"}>
        <code className={className}>{modelId}</code>
      </Tooltip>
    );
  }
  return (
    <Tooltip wide text={<ModelCard model={model} alias={alias} />}>
      <span className={className}>{model.name}</span>
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

function ModelCard(props: { model: ModelJson; alias: string | null }): ReactNode {
  const m = props.model;
  return (
    <div className="tip-card">
      <div className="tip-card-title">{m.name}</div>
      {props.alias !== null ? (
        <CardRow label="Alias">
          <code>{props.alias}</code>
        </CardRow>
      ) : null}
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
