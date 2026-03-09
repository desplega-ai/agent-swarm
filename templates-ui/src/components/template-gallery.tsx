"use client";

import { useMemo, useState } from "react";
import Fuse from "fuse.js";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TemplateCard } from "./template-card";
import type { TemplateConfig } from "../../../templates/schema";

type TemplateWithCategory = TemplateConfig & { category: string };

interface TemplateGalleryProps {
  templates: TemplateWithCategory[];
}

const categoryFilters = ["All", "Official", "Community"] as const;
const typeFilters = ["All", "Lead", "Worker"] as const;

export function TemplateGallery({ templates }: TemplateGalleryProps) {
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("All");
  const [typeFilter, setTypeFilter] = useState<string>("All");
  const [selectedCaps, setSelectedCaps] = useState<Set<string>>(new Set());

  const allCapabilities = useMemo(() => {
    const caps = new Set<string>();
    for (const t of templates) {
      for (const c of t.agentDefaults.capabilities) {
        caps.add(c);
      }
    }
    return Array.from(caps).sort();
  }, [templates]);

  const fuse = useMemo(
    () =>
      new Fuse(templates, {
        keys: [
          "name",
          "displayName",
          "description",
          "agentDefaults.role",
          "agentDefaults.capabilities",
        ],
        threshold: 0.4,
      }),
    [templates]
  );

  const filtered = useMemo(() => {
    let results = query
      ? fuse.search(query).map((r) => r.item)
      : [...templates];

    if (categoryFilter !== "All") {
      results = results.filter(
        (t) => t.category === categoryFilter.toLowerCase()
      );
    }

    if (typeFilter !== "All") {
      if (typeFilter === "Lead") {
        results = results.filter((t) => t.agentDefaults.isLead);
      } else {
        results = results.filter((t) => !t.agentDefaults.isLead);
      }
    }

    if (selectedCaps.size > 0) {
      results = results.filter((t) =>
        t.agentDefaults.capabilities.some((c) => selectedCaps.has(c))
      );
    }

    return results;
  }, [query, categoryFilter, typeFilter, selectedCaps, templates, fuse]);

  const toggleCap = (cap: string) => {
    setSelectedCaps((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search templates..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border border-input bg-background py-2 pl-10 pr-4 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4">
        <div className="flex gap-1.5">
          {categoryFilters.map((f) => (
            <Badge
              key={f}
              variant={categoryFilter === f ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => setCategoryFilter(f)}
            >
              {f}
            </Badge>
          ))}
        </div>
        <div className="flex gap-1.5">
          {typeFilters.map((f) => (
            <Badge
              key={f}
              variant={typeFilter === f ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => setTypeFilter(f)}
            >
              {f}
            </Badge>
          ))}
        </div>
      </div>

      {/* Capability tags */}
      <div className="flex flex-wrap gap-1.5">
        {allCapabilities.map((cap) => (
          <Badge
            key={cap}
            variant={selectedCaps.has(cap) ? "default" : "secondary"}
            className="cursor-pointer text-xs"
            onClick={() => toggleCap(cap)}
          >
            {cap}
          </Badge>
        ))}
      </div>

      {/* Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map((t) => (
          <TemplateCard key={`${t.category}/${t.name}`} template={t} />
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="text-center text-muted-foreground">
          No templates match your filters.
        </p>
      )}
    </div>
  );
}
