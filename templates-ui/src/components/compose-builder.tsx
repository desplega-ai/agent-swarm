"use client";

import { useMemo, useState } from "react";
import { Minus, Plus, Trash2 } from "lucide-react";
import {
  Crown,
  Code,
  Search,
  Eye,
  TestTube,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ComposePreview } from "./compose-preview";
import {
  generateCompose,
  generateEnv,
  type ServiceEntry,
  type ComposeConfig,
} from "@/lib/compose-generator";
import type { TemplateConfig } from "../../../templates/schema";

type TemplateWithCategory = TemplateConfig & { category: string };

const iconMap: Record<string, LucideIcon> = {
  crown: Crown,
  code: Code,
  search: Search,
  eye: Eye,
  "test-tube": TestTube,
};

interface ComposeBuilderProps {
  templates: TemplateWithCategory[];
}

function makeDefaultServices(
  templates: TemplateWithCategory[]
): ServiceEntry[] {
  const entries: ServiceEntry[] = [];
  const lead = templates.find((t) => t.name === "lead");
  const coder = templates.find((t) => t.name === "coder");

  if (lead) {
    entries.push({
      template: `${lead.category}/${lead.name}`,
      displayName: lead.displayName,
      count: 1,
      role: lead.agentDefaults.role,
      isLead: lead.agentDefaults.isLead,
    });
  }

  if (coder) {
    entries.push({
      template: `${coder.category}/${coder.name}`,
      displayName: coder.displayName,
      count: 2,
      role: coder.agentDefaults.role,
      isLead: coder.agentDefaults.isLead,
    });
  }

  return entries;
}

export function ComposeBuilder({ templates }: ComposeBuilderProps) {
  const [services, setServices] = useState<ServiceEntry[]>(() =>
    makeDefaultServices(templates)
  );
  const [apiImage, setApiImage] = useState(
    "ghcr.io/desplega-ai/agent-swarm:latest"
  );
  const [workerImage, setWorkerImage] = useState(
    "ghcr.io/desplega-ai/agent-swarm-worker:latest"
  );
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
    [services, apiImage, workerImage, startingPort, integrations]
  );

  const compose = useMemo(() => generateCompose(config), [config]);
  const env = useMemo(() => generateEnv(config), [config]);

  const addService = (t: TemplateWithCategory) => {
    const exists = services.find(
      (s) => s.template === `${t.category}/${t.name}`
    );
    if (exists) {
      setServices(
        services.map((s) =>
          s.template === exists.template ? { ...s, count: s.count + 1 } : s
        )
      );
    } else {
      setServices([
        ...services,
        {
          template: `${t.category}/${t.name}`,
          displayName: t.displayName,
          count: 1,
          role: t.agentDefaults.role,
          isLead: t.agentDefaults.isLead,
        },
      ]);
    }
  };

  const updateCount = (idx: number, delta: number) => {
    setServices(
      services
        .map((s, i) => (i === idx ? { ...s, count: Math.max(0, s.count + delta) } : s))
        .filter((s) => s.count > 0)
    );
  };

  const removeService = (idx: number) => {
    setServices(services.filter((_, i) => i !== idx));
  };

  const availableToAdd = templates.filter(
    (t) => !services.some((s) => s.template === `${t.category}/${t.name}`)
  );

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      {/* Left: Configuration */}
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold mb-3">Agent Roles</h2>
          <div className="space-y-2">
            {services.map((svc, idx) => {
              const tpl = templates.find(
                (t) => `${t.category}/${t.name}` === svc.template
              );
              const Icon = tpl ? iconMap[tpl.icon] ?? Code : Code;

              return (
                <div
                  key={svc.template}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <Icon className="h-5 w-5 text-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{svc.displayName}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {svc.template}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => updateCount(idx, -1)}
                      className="rounded-md p-1 hover:bg-accent transition-colors"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <span className="w-8 text-center text-sm font-mono">
                      {svc.count}
                    </span>
                    <button
                      onClick={() => updateCount(idx, 1)}
                      className="rounded-md p-1 hover:bg-accent transition-colors"
                      disabled={svc.count >= 10}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => removeService(idx)}
                      className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors ml-1"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {availableToAdd.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground mb-2">Add role:</p>
              <div className="flex flex-wrap gap-1.5">
                {availableToAdd.map((t) => (
                  <Badge
                    key={`${t.category}/${t.name}`}
                    variant="outline"
                    className="cursor-pointer hover:bg-accent"
                    onClick={() => addService(t)}
                  >
                    + {t.displayName}
                  </Badge>
                ))}
              </div>
            </div>
          )}
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
              <label className="text-sm text-muted-foreground">
                Worker Image
              </label>
              <input
                type="text"
                value={workerImage}
                onChange={(e) => setWorkerImage(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono"
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">
                Starting Port
              </label>
              <input
                type="number"
                value={startingPort}
                onChange={(e) => setStartingPort(Number(e.target.value))}
                className="mt-1 w-32 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono"
              />
            </div>
          </div>
        </div>

        {/* Integrations */}
        <div>
          <h2 className="text-lg font-semibold mb-3">Integrations</h2>
          <div className="space-y-2">
            {(
              Object.keys(integrations) as Array<keyof typeof integrations>
            ).map((key) => (
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
      </div>

      {/* Right: Preview */}
      <div className="lg:sticky lg:top-4 lg:self-start">
        <h2 className="text-lg font-semibold mb-3">Preview</h2>
        <ComposePreview compose={compose} env={env} />
      </div>
    </div>
  );
}
