"use client";

import Link from "next/link";
import { Calendar, GitBranch, Star, Wrench, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AgentAssetConfig, AgentAssetKind } from "../../../templates/schema";

const kindIcons: Record<AgentAssetKind, LucideIcon> = {
  skill: Wrench,
  schedule: Calendar,
  workflow: GitBranch,
};

const kindLabels: Record<AgentAssetKind, string> = {
  skill: "Skill",
  schedule: "Schedule",
  workflow: "Workflow",
};

interface AssetCardProps {
  asset: AgentAssetConfig;
}

export function AssetCard({ asset }: AssetCardProps) {
  const Icon = kindIcons[asset.kind];

  return (
    <Link
      href={`/${asset.category}/${asset.name}`}
      aria-label={`${asset.displayName} — ${kindLabels[asset.kind]} template`}
    >
      <Card className="h-full transition-colors hover:border-primary/50 hover:bg-card/80">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Icon className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">{asset.displayName}</CardTitle>
                <p className="text-xs text-muted-foreground capitalize">{asset.kind}</p>
              </div>
            </div>
            {asset.must ? (
              <Badge className="gap-1 bg-amber-500 text-xs text-white hover:bg-amber-500/90">
                <Star className="h-3 w-3 fill-current" />
                Must-have
              </Badge>
            ) : (
              <Badge
                variant={asset.runAllSeedersCandidate ? "default" : "secondary"}
                className="text-xs"
              >
                {asset.runAllSeedersCandidate ? "starter" : asset.kind}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <CardDescription className="mb-3 line-clamp-2">{asset.description}</CardDescription>
          <div className="flex flex-wrap gap-1.5">
            {asset.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
          {asset.placeholders.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Requires: {asset.placeholders.join(", ")}
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
