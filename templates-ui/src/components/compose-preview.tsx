"use client";

import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";

interface ComposePreviewProps {
  compose: string;
  env: string;
}

function downloadFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function highlightYaml(text: string) {
  return text.split("\n").map((line, i) => {
    if (line.startsWith("#")) {
      return (
        <div key={i} className="text-muted-foreground">
          {line}
        </div>
      );
    }

    // Highlight key: value pairs
    const match = line.match(/^(\s*-?\s*)([a-zA-Z_][a-zA-Z0-9_]*)(:\s*)(.*)/);
    if (match) {
      return (
        <div key={i}>
          <span>{match[1]}</span>
          <span className="text-primary">{match[2]}</span>
          <span>{match[3]}</span>
          <span className="text-foreground">{match[4]}</span>
        </div>
      );
    }

    return <div key={i}>{line}</div>;
  });
}

export function ComposePreview({ compose, env }: ComposePreviewProps) {
  const [activeTab, setActiveTab] = useState<"compose" | "env">("compose");

  const content = activeTab === "compose" ? compose : env;
  const filename = activeTab === "compose" ? "docker-compose.yml" : ".env";

  return (
    <div className="rounded-lg border border-border bg-muted/50">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex">
          <button
            onClick={() => setActiveTab("compose")}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              activeTab === "compose"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            docker-compose.yml
          </button>
          <button
            onClick={() => setActiveTab("env")}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              activeTab === "env"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            .env
          </button>
        </div>
        <div className="flex items-center gap-2">
          <CopyButton text={content} />
          <button
            onClick={() => downloadFile(content, filename)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
        </div>
      </div>
      <div className="overflow-auto max-h-[calc(100vh-20rem)] p-4">
        <pre className="text-sm font-mono leading-relaxed">
          <code>{highlightYaml(content)}</code>
        </pre>
      </div>
    </div>
  );
}
