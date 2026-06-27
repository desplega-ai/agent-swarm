import type { ReactNode } from "react";
import { useConfigs, useModels } from "../hooks.ts";
import type { AaBenchmarkJson, ConfigJson } from "../types.ts";
import { HarnessIcon } from "./HarnessIcon.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Reusable config rendering (v4 item 13), analogous to ModelChip: harness icon
 * + pretty model name, with a hover card carrying the full config info (id,
 * label, provider, model, tier, env keys, isDefault — plus the Artificial
 * Analysis highlight rows when the catalog carries an `aa` block, v7.6 item D).
 * Data comes from the cached useConfigs() catalog; ids missing from the
 * registry (removed config / older run) gracefully fall back to the raw id.
 */
export function ConfigChip(props: {
  configId: string;
  /** Wrap the name in a link to #/configs/:id. */
  link?: boolean;
  dim?: boolean;
}): ReactNode {
  const { byId, loaded } = useConfigs();
  const models = useModels();
  const config = byId(props.configId);

  if (!config) {
    const tip = loaded
      ? "Not in the current config registry (removed, or an older run)"
      : "Loading config catalog…";
    return (
      <Tooltip text={tip}>
        <span className={props.dim ? "config-chip dim" : "config-chip"}>
          <NameOrLink configId={props.configId} link={props.link}>
            <code className="config-chip-id">{props.configId}</code>
          </NameOrLink>
        </span>
      </Tooltip>
    );
  }

  // Bare aliases ("opus", "haiku") don't resolve against models.dev — prefer
  // the config's own label over the raw alias so two configs sharing a model
  // stay distinguishable; the raw id/model always lives in the hover card.
  const name =
    config.model === null
      ? (config.label ?? "Default Model")
      : (models.resolve(config.model)?.name ?? config.label ?? config.model);

  return (
    <Tooltip wide text={<ConfigCard config={config} modelName={name} />}>
      <span className={props.dim ? "config-chip dim" : "config-chip"}>
        <HarnessIcon harness={config.provider} plain />
        <NameOrLink configId={config.id} link={props.link}>
          <span className="config-chip-name">{name}</span>
        </NameOrLink>
      </span>
    </Tooltip>
  );
}

function NameOrLink(props: { configId: string; link?: boolean; children: ReactNode }): ReactNode {
  if (!props.link) return props.children;
  return (
    <a className="entity-link config-chip-link" href={`#/configs/${props.configId}`}>
      {props.children}
    </a>
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

function ConfigCard(props: { config: ConfigJson; modelName: string }): ReactNode {
  const c = props.config;
  return (
    <div className="tip-card">
      <div className="tip-card-title">{c.label ?? c.id}</div>
      <CardRow label="Id">
        <code>{c.id}</code>
      </CardRow>
      {c.label !== null ? <CardRow label="Label">{c.label}</CardRow> : null}
      <CardRow label="Provider">
        <HarnessIcon harness={c.provider} plain /> {providerLabel(c.provider)}
      </CardRow>
      <CardRow label="Model">
        {c.model !== null ? <code>{c.model}</code> : <span className="dim">Harness default</span>}
      </CardRow>
      <CardRow label="Tier">{c.modelTier ?? <span className="dim">—</span>}</CardRow>
      <CardRow label="Env Keys">
        {c.envKeys.length > 0 ? c.envKeys.join(", ") : <span className="dim">—</span>}
      </CardRow>
      <CardRow label="Default">
        {c.isDefault ? <span className="tone-green">✓</span> : <span className="dim">—</span>}
      </CardRow>
      {c.aa ? <AaHighlightRows aa={c.aa} /> : null}
    </div>
  );
}

/**
 * Artificial Analysis highlights (v7.6 item D) — appended to the hover card
 * only when the catalog matched this config to an AA row; absent block renders
 * nothing. Full metrics + variant note live on the configs page / detail view.
 */
function AaHighlightRows(props: { aa: AaBenchmarkJson }): ReactNode {
  const aa = props.aa;
  return (
    <>
      <CardRow label="AA Intel">
        {aa.intelligenceIndex !== null ? (
          <>
            {aa.intelligenceIndex}
            {aa.provisional ? (
              <span className="tone-accent" title="Provisional AA measurement">
                *
              </span>
            ) : null}
          </>
        ) : (
          <span className="dim">—</span>
        )}
      </CardRow>
      <CardRow label="AA $/1M">
        {aa.blendedUsdPer1M !== null ? (
          `$${aa.blendedUsdPer1M.toFixed(2)}`
        ) : (
          <span className="dim">—</span>
        )}
      </CardRow>
      <CardRow label="AA Tok/s">
        {aa.medianTokensPerS !== null ? aa.medianTokensPerS : <span className="dim">—</span>}
      </CardRow>
      <CardRow label="AA Source">
        <span className="dim">{aa.sourceRow}</span>
      </CardRow>
    </>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}
