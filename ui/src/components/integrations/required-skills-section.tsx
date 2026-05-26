import { CheckCircle, Loader2, Wrench } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useInstallRemoteSkill } from "@/api/hooks/use-skills";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AgentRole, RecommendedSkill } from "@/lib/integrations-catalog";

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
 * Template skills with `templateRepo` set have a functional "Install on <role>"
 * button that calls `skill-install-remote` directly from this page. Skills
 * flagged `installOnSetup: true` are also installed automatically when the
 * parent integration form is saved for the first time.
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
  const installRemote = useInstallRemoteSkill();
  const [installed, setInstalled] = useState(false);

  async function handleInstall() {
    if (!recommended.templateRepo) return;
    try {
      await installRemote.mutateAsync({
        sourceRepo: recommended.templateRepo,
        sourcePath: recommended.templatePath,
      });
      setInstalled(true);
      toast.success(`Skill "${recommended.name}" installed successfully.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Install failed";
      toast.error(`Failed to install "${recommended.name}": ${msg}`);
    }
  }

  const canInstallRemote = recommended.source === "template" && !!recommended.templateRepo;

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-xs text-foreground">{recommended.name}</code>
          <SourceBadge skill={recommended} />
          {recommended.roles.map((role) => (
            <Badge key={role} variant="outline" size="tag">
              {role}
            </Badge>
          ))}
          {recommended.installOnSetup && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  size="tag"
                  className="border-status-active/30 text-status-active-strong cursor-default"
                >
                  auto-install
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                This skill is installed automatically when you save the integration for the first
                time — no manual step needed.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {recommended.reason && (
          <p className="text-xs text-muted-foreground leading-snug">{recommended.reason}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        {recommended.roles.map((role) => (
          <InstallOnRoleButton
            key={role}
            role={role}
            skillName={recommended.name}
            canInstallRemote={canInstallRemote}
            isLoading={installRemote.isPending}
            isInstalled={installed}
            onInstall={handleInstall}
          />
        ))}
      </div>
    </li>
  );
}

interface SourceBadgeProps {
  skill: RecommendedSkill;
}

function SourceBadge({ skill }: SourceBadgeProps) {
  if (skill.source === "swarm-registry") {
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
        {skill.templateRepo && skill.templatePath ? (
          <>
            Checked-in skill at{" "}
            <code className="font-mono">
              {skill.templateRepo}/{skill.templatePath}/SKILL.md
            </code>
            . Install via{" "}
            <code className="font-mono">
              skill-install-remote sourceRepo={skill.templateRepo} sourcePath={skill.templatePath}
            </code>
            .
          </>
        ) : (
          "Checked-in skill template — installable from the templates catalog."
        )}
      </TooltipContent>
    </Tooltip>
  );
}

interface InstallOnRoleButtonProps {
  role: AgentRole;
  skillName: string;
  canInstallRemote: boolean;
  isLoading: boolean;
  isInstalled: boolean;
  onInstall: () => void;
}

function InstallOnRoleButton({
  role,
  skillName,
  canInstallRemote,
  isLoading,
  isInstalled,
  onInstall,
}: InstallOnRoleButtonProps) {
  if (isInstalled) {
    return (
      <Badge
        variant="outline"
        size="tag"
        className="border-status-success/30 text-status-success-strong gap-1 px-2 py-1 h-auto"
      >
        <CheckCircle className="h-3 w-3" aria-hidden="true" />
        Installed on {role}
      </Badge>
    );
  }

  if (!canInstallRemote) {
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
              aria-label={`Install ${skillName} on ${role} — install from /settings/skills`}
            >
              <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
              Install on {role}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Install the skill from <code className="font-mono">/settings/skills</code> onto a {role}{" "}
          agent.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={isLoading}
      onClick={onInstall}
      className="gap-1"
      aria-label={`Install ${skillName} on ${role}`}
    >
      {isLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      Install on {role}
    </Button>
  );
}
