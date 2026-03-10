"use client";

import Link from "next/link";
import {
  Crown,
  Code,
  Search,
  Eye,
  TestTube,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TemplateConfig } from "../../../templates/schema";

const iconMap: Record<string, LucideIcon> = {
  crown: Crown,
  code: Code,
  search: Search,
  eye: Eye,
  "test-tube": TestTube,
};

interface TemplateCardProps {
  template: TemplateConfig & { category: string };
}

export function TemplateCard({ template }: TemplateCardProps) {
  const Icon = iconMap[template.icon] ?? Code;

  return (
    <Link
      href={`/${template.category}/${template.name}`}
      aria-label={`${template.displayName} — ${template.agentDefaults.role} template`}
    >
      <Card className="h-full transition-colors hover:border-primary/50 hover:bg-card/80">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Icon className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">
                  {template.displayName}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {template.agentDefaults.role}
                </p>
              </div>
            </div>
            <Badge
              variant={
                template.category === "official" ? "default" : "secondary"
              }
              className="text-xs"
            >
              {template.category}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <CardDescription className="mb-3 line-clamp-2">
            {template.description}
          </CardDescription>
          <div className="flex flex-wrap gap-1.5">
            {template.agentDefaults.capabilities.map((cap) => (
              <Badge key={cap} variant="outline" className="text-xs">
                {cap}
              </Badge>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>Max tasks: {template.agentDefaults.maxTasks}</span>
            <span>v{template.version}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
