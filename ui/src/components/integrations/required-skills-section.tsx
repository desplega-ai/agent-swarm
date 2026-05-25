import { Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AgentRole, RecommendedSkill, SkillSource } from "@/lib/integrations-catalog";

interface RecommendedSkillsSectionProps {
  /** Skills recommended alongside the integration to make it work end-to-end. */
  recommendedSkills: RecommendedSkill[];
}

/**
 * Renders the "Recommended skills" section under an integration's env-var inputs.
 *
 * Some integrations need procedural knowledge (a skill) installed on a specific
 * agent role for the env-var configuration to do something useful. Each skill
 * entry declares its source — 'swarm-registry' for skills already published in
 * the registry, 'template' for skills seeded from the built-in catalog.
 *
 * The "Install on <role>" button is a placeholder — clicking it does nothing.
 * See TODO below for the follow-up that wires the actual install API.
 */
export function RecommendedSkillsSection({ recommendedSkills }: RecommendedSkillsSectionProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
          Recommended skills
        </h2>
        <Badge variant="outline" size="tag">
          {recommendedSkills.length}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        Setting the env-vars above is not always enough — these skills should also be installed on
        the listed agent role(s) for the integration to function end-to-end.
      </p>
      <ul className="space-y-2">
        {recommendedSkills.map((rs) => (
          <RecommendedSkillRow key={rs.name} recommended={rs} />
        ))}
      </ul>
    </section>
  );
}

interface RecommendedSkillRowProps {
  recommended: RecommendedSkill;
}

function RecommendedSkillRow({ recommended }: RecommendedSkillRowProps) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-xs text-foreground">{recommended.name}</code>
          <SourceBadge source={recommended.source} />
          {recommended.roles.map((role) => (
            <Badge key={role} variant="outline" size="tag">
              {role}
            </Badge>
          ))}
        </div>
        {recommended.reason && (
          <p className="text-xs text-muted-foreground leading-snug">{recommended.reason}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        {recommended.roles.map((role) => (
          <InstallOnRoleButton key={role} role={role} skillName={recommended.name} />
        ))}
      </div>
    </li>
  );
}

interface SourceBadgeProps {
  source: SkillSource;
}

function SourceBadge({ source }: SourceBadgeProps) {
  if (source === "swarm-registry") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            size="tag"
            className="border-status-info/30 text-status-info-strong cursor-default"
          >
            registry
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Published in the swarm skills registry — installable from{" "}
          <code className="font-mono">/settings/skills</code>.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          size="tag"
          className="border-status-success/30 text-status-success-strong cursor-default"
        >
          template
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Checked-in skill template seeded from the built-in catalog on swarm boot.
      </TooltipContent>
    </Tooltip>
  );
}

interface InstallOnRoleButtonProps {
  role: AgentRole;
  skillName: string;
}

/**
 * TODO(integrations-ui): wire up real one-click install via
 * `useInstallSkill({ skillId, agentId })` once we settle on a skill-picker
 * UX for "Install on <role>". Until then this button is render-only and
 * the operator installs from /settings/skills.
 *
 * Future work also needs to detect the per-agent-role installation state
 * (call `/api/agents/{id}/skills` for each matching agent) and render a
 * green "Installed on <role>" instead of the install CTA when present.
 */
function InstallOnRoleButton({ role, skillName }: InstallOnRoleButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-block">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled
            className="gap-1 pointer-events-none"
            aria-label={`Install ${skillName} on ${role} (coming soon)`}
          >
            <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
            Install on {role}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        Coming soon: one-click install from this page. For now, install the skill from{" "}
        <code className="font-mono">/settings/skills</code> onto a {role} agent.
      </TooltipContent>
    </Tooltip>
  );
}
