"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

interface FilePreviewProps {
  content: string;
  filename: string;
  isShell?: boolean;
}

function highlightPlaceholders(text: string) {
  const parts = text.split(/({{[^}]+}})/g);
  return parts.map((part, i) => {
    if (part.startsWith("{{") && part.endsWith("}}")) {
      return (
        <span key={i} className="rounded bg-primary/20 px-1 text-primary font-medium">
          {part}
        </span>
      );
    }
    return part;
  });
}

export function FilePreview({ content, filename, isShell }: FilePreviewProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = content.split("\n");

  return (
    <div className="relative rounded-lg border border-border bg-muted/50">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <span className="text-sm font-mono text-muted-foreground">{filename}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="overflow-x-auto p-4">
        <pre className={`text-sm leading-relaxed ${isShell ? "font-mono" : ""}`}>
          {isShell ? (
            <code>
              {lines.map((line, i) => (
                <div key={i} className="flex">
                  <span className="mr-4 inline-block w-8 text-right text-muted-foreground select-none">
                    {i + 1}
                  </span>
                  <span>{highlightPlaceholders(line)}</span>
                </div>
              ))}
            </code>
          ) : (
            <code className="whitespace-pre-wrap">{highlightPlaceholders(content)}</code>
          )}
        </pre>
      </div>
    </div>
  );
}
