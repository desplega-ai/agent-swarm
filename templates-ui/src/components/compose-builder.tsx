"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Code,
  Crown,
  Eye,
  Minus,
  Plus,
  Search,
  TestTube,
  Trash2,
  type LucideIcon,
} from "lucide-react";

const iconMap: Record<string, LucideIcon> = {
  crown: Crown,
  code: Code,
  search: Search,
  eye: Eye,
  "test-tube": TestTube,
};
import { ComposePreview } from "./compose-preview";
import {
  generateCompose,
  generateEnv,
  type ServiceEntry,
  type ComposeConfig,
} from "@/lib/compose-generator";
import type { TemplateConfig } from "../../../templates/schema";

type TemplateWithCategory = TemplateConfig & { category: string };

interface ComposeBuilderProps {
  templates: TemplateWithCategory[];
}

function makeLeadEntry(t: TemplateWithCategory | undefined): ServiceEntry {
  if (t) {
    return {
      template: `${t.category}/${t.name}`,
      displayName: t.displayName,
      count: 1,
      role: t.agentDefaults.role,
      isLead: true,
    };
  }
  return { template: "", displayName: "Lead Agent", count: 1, role: "Lead", isLead: true };
}

function makeDefaultWorkers(templates: TemplateWithCategory[]): ServiceEntry[] {
  const coder = templates.find((t) => t.name === "coder");
  if (!coder) return [];
  return [
    {
      template: `${coder.category}/${coder.name}`,
      displayName: coder.displayName,
      count: 2,
      role: coder.agentDefaults.role,
      isLead: false,
    },
  ];
}

export function ComposeBuilder({ templates }: ComposeBuilderProps) {
  const [leadService, setLeadService] = useState<ServiceEntry>(() =>
    makeLeadEntry(templates.find((t) => t.name === "lead")),
  );
  const [workers, setWorkers] = useState<ServiceEntry[]>(() => makeDefaultWorkers(templates));

  const services = useMemo(() => [leadService, ...workers], [leadService, workers]);
  const [apiImage, setApiImage] = useState("ghcr.io/desplega-ai/agent-swarm:latest");
  const [workerImage, setWorkerImage] = useState("ghcr.io/desplega-ai/agent-swarm-worker:latest");
  const [startingPort, setStartingPort] = useState(3020);
  const [integrations, setIntegrations] = useState({
    slack: false,
    github: true,
    gitlab: false,
    sentry: false,
  });

  const config: ComposeConfig = useMemo(
    () => ({
      services,
      apiImage,
      workerImage,
      startingPort,
      integrations,
    }),
    [services, apiImage, workerImage, startingPort, integrations],
  );

  const compose = useMemo(() => generateCompose(config), [config]);
  const env = useMemo(() => generateEnv(config), [config]);

  const changeLeadTemplate = (templateKey: string | null) => {
    if (!templateKey) {
      setLeadService({
        template: "",
        displayName: "Lead Agent",
        count: 1,
        role: "Lead",
        isLead: true,
      });
      return;
    }
    const t = templates.find((tpl) => `${tpl.category}/${tpl.name}` === templateKey);
    if (!t) return;
    setLeadService({
      template: templateKey,
      displayName: t.displayName,
      count: 1,
      role: t.agentDefaults.role,
      isLead: true,
    });
  };

  const addWorker = () => {
    setWorkers([
      ...workers,
      { template: "", displayName: "Worker", count: 1, role: "Worker", isLead: false },
    ]);
  };

  const updateWorkerCount = (idx: number, delta: number) => {
    setWorkers(
      workers
        .map((s, i) => (i === idx ? { ...s, count: Math.max(0, s.count + delta) } : s))
        .filter((s) => s.count > 0),
    );
  };

  const removeWorker = (idx: number) => {
    setWorkers(workers.filter((_, i) => i !== idx));
  };

  const changeWorkerTemplate = (idx: number, templateKey: string | null) => {
    if (!templateKey) {
      setWorkers(
        workers.map((s, i) =>
          i === idx ? { ...s, template: "", displayName: "Worker", role: "Worker" } : s,
        ),
      );
      return;
    }
    const t = templates.find((tpl) => `${tpl.category}/${tpl.name}` === templateKey);
    if (!t) return;
    setWorkers(
      workers.map((s, i) =>
        i === idx
          ? {
              ...s,
              template: templateKey,
              displayName: t.displayName,
              role: t.agentDefaults.role,
              isLead: false,
            }
          : s,
      ),
    );
  };

  return (
    <div className="grid lg:h-full lg:grid-cols-2 lg:overflow-hidden">
      {/* Left: Configuration */}
      <div className="min-w-0 lg:overflow-y-auto px-0 py-4 lg:px-4 lg:pr-4 space-y-6">
        {/* Integrations — on top */}
        <div>
          <h2 className="text-lg font-semibold mb-3">Integrations</h2>
          <div className="flex flex-wrap gap-3">
            {(Object.keys(integrations) as Array<keyof typeof integrations>).map((key) => (
              <label key={key} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={integrations[key]}
                  onChange={(e) =>
                    setIntegrations({
                      ...integrations,
                      [key]: e.target.checked,
                    })
                  }
                  className="rounded border-input accent-primary"
                />
                <span className="text-sm capitalize">{key}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Swarm Configuration */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Swarm Configuration</h2>

          {/* Lead */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Lead</h3>
            <div className="flex items-center gap-3 rounded-lg border border-border p-3">
              <Crown className="h-5 w-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <TemplateDropdown
                  templates={templates}
                  value={leadService.template}
                  isLead={true}
                  onChange={changeLeadTemplate}
                />
              </div>
              <span className="shrink-0 text-xs text-muted-foreground font-mono">x1</span>
            </div>
          </div>

          {/* Workers */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-2">Workers</h3>
            <div className="space-y-2">
              {workers.map((svc, idx) => {
                const tpl = svc.template
                  ? templates.find((t) => `${t.category}/${t.name}` === svc.template)
                  : null;
                const WorkerIcon = tpl ? (iconMap[tpl.icon] ?? Bot) : Bot;
                return (
                  <div key={idx} className="rounded-lg border border-border p-3 space-y-2">
                    <div className="flex items-center gap-3">
                      <WorkerIcon className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <TemplateDropdown
                          templates={templates}
                          value={svc.template}
                          isLead={false}
                          onChange={(key) => changeWorkerTemplate(idx, key)}
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => updateWorkerCount(idx, -1)}
                        className="rounded-md p-1 hover:bg-accent transition-colors"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <span className="w-8 text-center text-sm font-mono">{svc.count}</span>
                      <button
                        onClick={() => updateWorkerCount(idx, 1)}
                        className="rounded-md p-1 hover:bg-accent transition-colors"
                        disabled={svc.count >= 10}
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => removeWorker(idx)}
                        className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors ml-1"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              onClick={addWorker}
              className="mt-2 w-full rounded-lg border border-dashed border-border p-2 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
            >
              + Add worker
            </button>
          </div>
        </div>

        {/* Settings */}
        <div>
          <h2 className="text-lg font-semibold mb-3">Settings</h2>
          <div className="space-y-3">
            <div>
              <label className="text-sm text-muted-foreground">API Image</label>
              <input
                type="text"
                value={apiImage}
                onChange={(e) => setApiImage(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono"
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">Worker Image</label>
              <input
                type="text"
                value={workerImage}
                onChange={(e) => setWorkerImage(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono"
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm text-muted-foreground whitespace-nowrap">
                Starting Port
              </label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={startingPort}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isNaN(v)) setStartingPort(v);
                }}
                className="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Right: Preview */}
      <div className="min-w-0 px-0 py-4 lg:px-4 lg:pl-4 border-t lg:border-t-0 lg:border-l border-border">
        <h2 className="text-lg font-semibold mb-3">Preview</h2>
        <ComposePreview compose={compose} env={env} />
      </div>
    </div>
  );
}

function TemplateDropdown({
  templates,
  value,
  isLead,
  onChange,
}: {
  templates: TemplateWithCategory[];
  value: string;
  isLead: boolean;
  onChange: (templateKey: string | null) => void;
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

  // Filter templates by type (lead vs worker) to match the current service
  const relevantTemplates = templates.filter((t) => !!t.agentDefaults.isLead === isLead);

  const filtered = search
    ? relevantTemplates.filter(
        (t) =>
          t.displayName.toLowerCase().includes(search.toLowerCase()) ||
          t.name.toLowerCase().includes(search.toLowerCase()),
      )
    : relevantTemplates;

  const current = templates.find((t) => `${t.category}/${t.name}` === value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-md border border-input bg-background px-2 py-1 text-sm hover:bg-accent/50 transition-colors"
      >
        <span className={current ? "text-foreground" : "text-muted-foreground"}>
          {current ? current.displayName : "No template"}
        </span>
        <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1 w-56 rounded-lg border border-input bg-background shadow-lg">
          <div className="border-b border-input p-2">
            <input
              type="text"
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md bg-transparent px-2 py-1 text-sm placeholder:text-muted-foreground focus:outline-none"
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-y-auto p-1">
            {/* None option */}
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors text-muted-foreground"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-input">
                {!value && <Check className="h-3 w-3" />}
              </span>
              None
            </button>
            {filtered.map((t) => {
              const key = `${t.category}/${t.name}`;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    onChange(key);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors"
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-input">
                    {value === key && <Check className="h-3 w-3" />}
                  </span>
                  {t.displayName}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No templates found.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
