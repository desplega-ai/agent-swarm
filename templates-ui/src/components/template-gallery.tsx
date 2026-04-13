"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import { Check, ChevronDown, Search, X } from "lucide-react";
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
    [templates],
  );

  const filtered = useMemo(() => {
    let results = query ? fuse.search(query).map((r) => r.item) : [...templates];

    if (categoryFilter !== "All") {
      results = results.filter((t) => t.category === categoryFilter.toLowerCase());
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
        t.agentDefaults.capabilities.some((c) => selectedCaps.has(c)),
      );
    }

    // Sort: leads first, then workers
    results.sort((a, b) => {
      const aLead = a.agentDefaults.isLead ? 0 : 1;
      const bLead = b.agentDefaults.isLead ? 0 : 1;
      return aLead - bLead;
    });

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

      {/* Capability multi-select */}
      <CapabilityMultiSelect
        capabilities={allCapabilities}
        selected={selectedCaps}
        onToggle={toggleCap}
        onClear={() => setSelectedCaps(new Set())}
      />

      {/* Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map((t) => (
          <TemplateCard key={`${t.category}/${t.name}`} template={t} />
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="text-center text-muted-foreground">No templates match your filters.</p>
      )}
    </div>
  );
}

function CapabilityMultiSelect({
  capabilities,
  selected,
  onToggle,
  onClear,
}: {
  capabilities: string[];
  selected: Set<string>;
  onToggle: (cap: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = search
    ? capabilities.filter((c) => c.toLowerCase().includes(search.toLowerCase()))
    : capabilities;

  return (
    <div ref={ref} className="relative w-full max-w-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground hover:bg-accent/50 transition-colors"
      >
        <span className="truncate text-muted-foreground">
          {selected.size === 0 ? "Filter by capabilities..." : `${selected.size} selected`}
        </span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {selected.size > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {Array.from(selected).map((cap) => (
            <Badge
              key={cap}
              variant="default"
              className="cursor-pointer gap-1 text-xs"
              onClick={() => onToggle(cap)}
            >
              {cap}
              <X className="h-3 w-3" />
            </Badge>
          ))}
          <Badge variant="outline" className="cursor-pointer text-xs" onClick={onClear}>
            Clear all
          </Badge>
        </div>
      )}

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-input bg-background shadow-lg">
          <div className="border-b border-input p-2">
            <input
              type="text"
              placeholder="Search capabilities..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md bg-transparent px-2 py-1 text-sm placeholder:text-muted-foreground focus:outline-none"
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No capabilities found.</p>
            )}
            {filtered.map((cap) => (
              <button
                key={cap}
                type="button"
                onClick={() => onToggle(cap)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-input">
                  {selected.has(cap) && <Check className="h-3 w-3" />}
                </span>
                {cap}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
