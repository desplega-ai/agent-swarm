import { Check, Copy, ExternalLink, Server, SquareTerminal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { BrandLogo } from "@/components/shared/brand-logo";
import { SetupCard } from "@/components/shared/setup-card";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/**
 * The install prompt of the landing page (`PROMPT_TEXT` in
 * agent-swarm-landing/src/lib/landing-v2-copy.ts). Keep the two in sync.
 */
export const INSTALL_PROMPT =
  "Read https://agent-swarm.dev/skill.md and help me install and operate Agent Swarm on our infra. Ask about my setup before running anything.";

export const DEPLOY_GUIDE_URL = "https://docs.agent-swarm.dev/docs/guides/one-click-deploy";

/**
 * Ways to start a server without a coding agent. Only Railway is a one-click
 * deploy; the others open the guide section until their listing is live.
 */
const DEPLOY_OPTIONS = [
  {
    label: "Deploy on Railway",
    href: "https://railway.com/deploy/agent-swarm",
    icon: <BrandLogo src="/deploy-logos/railway.svg" className="size-4" />,
  },
  {
    label: "DigitalOcean guide",
    href: `${DEPLOY_GUIDE_URL}#digitalocean-1-click`,
    icon: <BrandLogo src="/deploy-logos/digitalocean.svg" className="size-4" />,
  },
  {
    label: "Any VPS guide",
    href: `${DEPLOY_GUIDE_URL}#cloud-init-on-any-vps`,
    icon: <Server />,
  },
];

/**
 * Step 1 with no connection yet: the first way to get a swarm. The person
 * pastes the prompt in a coding agent, which installs the swarm and ends with
 * a dashboard link that fills in the connect form.
 */
export function InstallPromptCard() {
  const { copied, copy } = useCopyToClipboard();
  const [copyFailed, setCopyFailed] = useState(false);

  return (
    <SetupCard
      icon={<SquareTerminal className="size-4" />}
      title="Ask your coding agent"
      description="It reads our skill, asks about your setup, then installs the swarm."
    >
      <div className="flex flex-col gap-3">
        <p className="rounded-lg border border-border-subtle bg-surface px-3.5 py-3 font-mono text-data leading-relaxed text-foreground">
          {INSTALL_PROMPT}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* One width: only the icon swaps, the label stays. */}
          <Button
            type="button"
            onClick={async () => setCopyFailed(!(await copy(INSTALL_PROMPT)))}
            aria-label={copied ? "Copied" : "Copy install prompt"}
          >
            {copied ? <Check /> : <Copy />}
            Copy prompt
          </Button>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {copyFailed
              ? "Could not copy. Select the text and copy it."
              : "Paste it in Claude Code, Codex, or any coding agent."}
          </p>
        </div>
        {/* Each deploy ends with a `/setup` link that fills in the connect form. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
          <span className="mr-1 text-xs text-muted-foreground">Or deploy a server</span>
          {DEPLOY_OPTIONS.map((option) => (
            <Button key={option.href} asChild variant="outline" size="sm">
              <a href={option.href} target="_blank" rel="noopener noreferrer">
                {option.icon}
                {option.label}
                <ExternalLink className="size-3 text-muted-foreground" />
              </a>
            </Button>
          ))}
        </div>
      </div>
    </SetupCard>
  );
}

/** A quiet "or" between two ways to do the same thing. */
export function OrDivider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border-subtle" />
      {children}
      <span aria-hidden className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}
