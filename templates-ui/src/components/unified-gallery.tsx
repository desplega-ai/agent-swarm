"use client";

import { useMemo, useState } from "react";
import Fuse from "fuse.js";
import { Bot, Calendar, GitBranch, Search, Star, Wrench, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TemplateCard } from "./template-card";
import { AssetCard } from "./asset-card";
import type { AgentAssetConfig, TemplateConfig } from "../../../templates/schema";

type TemplateWithCategory = TemplateConfig & { category: string };

type UnifiedItem =
  | { type: "agent"; key: string; template: TemplateWithCategory }
  | { type: "skill" | "schedule" | "workflow"; key: string; asset: AgentAssetConfig };

interface UnifiedGalleryProps {
  templates: TemplateWithCategory[];
  assets: AgentAssetConfig[];
}

type FilterKey = "all" | "essentials" | "agent" | "skill" | "schedule" | "workflow";

const typeMeta: Record<
  "agent" | "skill" | "schedule" | "workflow",
  { label: string; Icon: LucideIcon; accent: string }
> = {
  agent: { label: "Agents", Icon: Bot, accent: "text-violet-500" },
  skill: { label: "Skills", Icon: Wrench, accent: "text-sky-500" },
  schedule: { label: "Schedules", Icon: Calendar, accent: "text-emerald-500" },
  workflow: { label: "Workflows", Icon: GitBranch, accent: "text-amber-500" },
};

const typeOrder: Record<UnifiedItem["type"], number> = {
  agent: 0,
  skill: 1,
  schedule: 2,
  workflow: 3,
};

function searchDoc(item: UnifiedItem) {
  if (item.type === "agent") {
    const t = item.template;
    return {
      type: "agent",
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      tags: t.agentDefaults.capabilities,
      extra: t.agentDefaults.role,
    };
  }
  const a = item.asset;
  return {
    type: a.kind,
    name: a.name,
    displayName: a.displayName,
    description: a.description,
    tags: a.tags,
    extra: a.kind,
  };
}

export function UnifiedGallery({ templates, assets }: UnifiedGalleryProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");

  const items = useMemo<UnifiedItem[]>(() => {
    const agentItems: UnifiedItem[] = templates.map((t) => ({
      type: "agent",
      key: `${t.category}/${t.name}`,
      template: t,
    }));
    const assetItems: UnifiedItem[] = assets.map((a) => ({
      type: a.kind,
      key: `${a.category}/${a.name}`,
      asset: a,
    }));
    return [...agentItems, ...assetItems];
  }, [templates, assets]);

  const docs = useMemo(() => items.map((item) => ({ item, ...searchDoc(item) })), [items]);

  const fuse = useMemo(
    () =>
      new Fuse(docs, {
        keys: ["name", "displayName", "description", "tags", "extra"],
        threshold: 0.4,
      }),
    [docs],
  );

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = {
      all: items.length,
      essentials: 0,
      agent: 0,
      skill: 0,
      schedule: 0,
      workflow: 0,
    };
    for (const item of items) {
      c[item.type] += 1;
      if (item.type !== "agent" && item.asset.must) c.essentials += 1;
    }
    return c;
  }, [items]);

  const filtered = useMemo(() => {
    let results = query ? fuse.search(query).map((r) => r.item.item) : [...items];

    if (filter === "essentials") {
      results = results.filter((i) => i.type !== "agent" && i.asset.must);
    } else if (filter !== "all") {
      results = results.filter((i) => i.type === filter);
    }

    results.sort((a, b) => {
      const aMust = a.type !== "agent" && a.asset.must ? 0 : 1;
      const bMust = b.type !== "agent" && b.asset.must ? 0 : 1;
      if (aMust !== bMust) return aMust - bMust;
      if (typeOrder[a.type] !== typeOrder[b.type]) return typeOrder[a.type] - typeOrder[b.type];
      const an = a.type === "agent" ? a.template.displayName : a.asset.displayName;
      const bn = b.type === "agent" ? b.template.displayName : b.asset.displayName;
      return an.localeCompare(bn);
    });

    return results;
  }, [query, filter, items, fuse]);

  const filterChips: { key: FilterKey; label: string; Icon?: LucideIcon }[] = [
    { key: "all", label: "All" },
    { key: "essentials", label: "Essentials", Icon: Star },
    { key: "agent", label: typeMeta.agent.label, Icon: typeMeta.agent.Icon },
    { key: "skill", label: typeMeta.skill.label, Icon: typeMeta.skill.Icon },
    { key: "schedule", label: typeMeta.schedule.label, Icon: typeMeta.schedule.Icon },
    { key: "workflow", label: typeMeta.workflow.label, Icon: typeMeta.workflow.Icon },
  ];

  return (
    <div className="space-y-6">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search agents, skills, schedules & workflows..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border border-input bg-background py-2.5 pl-10 pr-4 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Type filters */}
      <div className="flex flex-wrap gap-1.5">
        {filterChips.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
          >
            <Badge
              variant={filter === key ? "default" : "outline"}
              className="cursor-pointer gap-1.5"
            >
              {Icon && (
                <Icon
                  className={`h-3 w-3 ${key === "essentials" && filter !== key ? "text-amber-500" : ""}`}
                />
              )}
              {label}
              <span className={filter === key ? "opacity-80" : "text-muted-foreground"}>
                {counts[key]}
              </span>
            </Badge>
          </button>
        ))}
      </div>

      {/* Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map((item) =>
          item.type === "agent" ? (
            <TemplateCard key={item.key} template={item.template} />
          ) : (
            <AssetCard key={item.key} asset={item.asset} />
          ),
        )}
      </div>

      {filtered.length === 0 && (
        <p className="py-12 text-center text-muted-foreground">
          Nothing matches your search. Try a different term or clear the filter.
        </p>
      )}
    </div>
  );
}
