import { ExternalLink } from "lucide-react";
import type { MouseEvent } from "react";
import { SwarmLinkView, useSwarmLinkOrigins } from "@/components/shared/markdown-link-chip";
import { parseSwarmLinkOrRef } from "@/lib/swarm-links";
import { safeHttpUrl } from "./card-grid-model";
import type { LinkCell } from "./link-cell-model";

/**
 * A link cell. A GitHub PR / issue / commit / repo URL, `owner/repo#N`, a
 * dashboard task / agent / session / app / page URL and an agent-fs file
 * render as the dashboard's link chip (the one markdown uses): icon plus a
 * short label. Any other http(s) URL is a plain external link, and anything
 * else is text. `label` replaces the derived label, so a cell can read
 * `agent-swarm#2605` over a PR URL.
 */
export function SmartLink({ cell, noTip = false }: { cell: LinkCell; noTip?: boolean }) {
  const origins = useSwarmLinkOrigins();
  const { target, label } = cell;
  // A click on the link is not a click on the row or card around it.
  const onClick = (event: MouseEvent<HTMLElement>) => event.stopPropagation();
  if (!target) return label ? <span className="block min-w-0 truncate">{label}</span> : null;

  const link = parseSwarmLinkOrRef(target, origins);
  if (link)
    return <SwarmLinkView link={link} label={label ?? undefined} onClick={onClick} noTip={noTip} />;

  const href = safeHttpUrl(target);
  if (!href) return <span className="block min-w-0 truncate">{label ?? target}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className="inline-flex min-w-0 max-w-full items-center gap-1 text-primary hover:underline"
    >
      <span className="min-w-0 truncate">{label ?? target}</span>
      <ExternalLink aria-hidden className="size-3 shrink-0" />
    </a>
  );
}
