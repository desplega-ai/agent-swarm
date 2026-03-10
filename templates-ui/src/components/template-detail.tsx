"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { FilePreview } from "./file-preview";
import type { TemplateResponse } from "../../../templates/schema";

interface TemplateDetailProps {
  template: TemplateResponse;
  category: string;
}

const fileTabs = [
  { key: "claudeMd" as const, label: "CLAUDE.md", shell: false },
  { key: "soulMd" as const, label: "SOUL.md", shell: false },
  { key: "identityMd" as const, label: "IDENTITY.md", shell: false },
  { key: "toolsMd" as const, label: "TOOLS.md", shell: false },
  { key: "setupScript" as const, label: "start-up.sh", shell: true },
];

export function TemplateDetail({ template, category }: TemplateDetailProps) {
  const [activeTab, setActiveTab] = useState<keyof TemplateResponse["files"]>("claudeMd");
  const [copied, setCopied] = useState(false);

  const templateId = `${category}/${template.config.name}`;

  const handleCopyId = async () => {
    await navigator.clipboard.writeText(`TEMPLATE_ID=${templateId}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const activeFile = fileTabs.find((t) => t.key === activeTab)!;

  return (
    <div className="space-y-8">
      {/* Metadata */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl font-bold">{template.config.displayName}</h1>
          <Badge variant={category === "official" ? "default" : "secondary"}>
            {category}
          </Badge>
          <Badge variant="outline">v{template.config.version}</Badge>
        </div>
        <p className="text-lg text-muted-foreground mb-4">
          {template.config.description}
        </p>
        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          <span>
            Role: <strong className="text-foreground">{template.config.agentDefaults.role}</strong>
          </span>
          <span>
            Max tasks: <strong className="text-foreground">{template.config.agentDefaults.maxTasks}</strong>
          </span>
          <span>
            Author: <strong className="text-foreground">{template.config.author}</strong>
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {template.config.agentDefaults.capabilities.map((cap) => (
            <Badge key={cap} variant="outline" className="text-xs">
              {cap}
            </Badge>
          ))}
        </div>
      </div>

      {/* Use this template */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold mb-2">Use this template</h2>
        <div className="flex items-center gap-3">
          <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm">
            TEMPLATE_ID={templateId}
          </code>
          <button
            onClick={handleCopyId}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent transition-colors"
          >
            {copied ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Add this to your worker&apos;s environment variables, or use the{" "}
          <a href="/builder" className="text-primary hover:underline">
            Docker Compose Builder
          </a>{" "}
          to generate a full configuration.
        </p>
      </div>

      {/* File tabs */}
      <div>
        <div className="flex overflow-x-auto overflow-y-hidden border-b border-border">
          {fileTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`shrink-0 whitespace-nowrap px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="mt-4">
          <FilePreview
            content={template.files[activeTab]}
            filename={activeFile.label}
            isShell={activeFile.shell}
          />
        </div>
      </div>
    </div>
  );
}
