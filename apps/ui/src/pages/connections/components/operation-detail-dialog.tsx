import type { ReactNode } from "react";
import type { ScriptConnectionOperation, ScriptConnectionTool } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { normalizeScriptSlug } from "@/pages/connections/page";
import { JsonSourceViewer } from "./code-viewer-dialog";
import { CopyIconButton } from "./copy-icon-button";

/** Either an OpenAPI operation or an MCP tool — exactly one is set. */
export type OperationDetailSubject =
  | { kind: "operation"; operation: ScriptConnectionOperation }
  | { kind: "tool"; tool: ScriptConnectionTool };

function prettySchema(schema: unknown): string {
  return JSON.stringify(schema, null, 2) ?? "";
}

function isNonEmptySchema(schema: unknown): boolean {
  if (schema === undefined || schema === null) return false;
  if (typeof schema === "object") return Object.keys(schema as object).length > 0;
  return true;
}

/** Compact type label for a JSON-schema fragment (e.g. "string", "string[]", enum union). */
function schemaTypeLabel(schema: unknown): string {
  if (typeof schema === "boolean") return schema ? "any" : "never";
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "any";
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum)) {
    return record.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  const type = typeof record.type === "string" ? record.type : undefined;
  if (type === "array") return `${schemaTypeLabel(record.items)}[]`;
  if (type) return type;
  if (record.properties && typeof record.properties === "object") return "object";
  return "any";
}

function snippetKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function operationSnippet(slug: string, operation: ScriptConnectionOperation): string {
  const namespace = normalizeScriptSlug(slug) || "myConnection";
  const parameters = operation.parameters ?? [];
  const group = (place: string) => parameters.filter((parameter) => parameter.in === place);
  const groupEntry = (place: string) => {
    const entries = group(place);
    if (!entries.length) return null;
    return `${place}: { ${entries.map((parameter) => `${snippetKey(parameter.name)}: "..."`).join(", ")} }`;
  };
  const groups = [
    groupEntry("path"),
    groupEntry("query"),
    groupEntry("header"),
    operation.hasBody ? "body: { ... }" : null,
  ].filter((entry): entry is string => entry !== null);
  const args = groups.length ? `{ ${groups.join(", ")} }` : "{}";
  return `await ctx.api.${namespace}.${operation.name}(${args});`;
}

function toolSnippet(slug: string, tool: ScriptConnectionTool): string {
  const namespace = normalizeScriptSlug(slug) || "myConnection";
  const method = normalizeScriptSlug(tool.name) || tool.name;
  const schema =
    tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
      ? (tool.inputSchema as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
  const args = required.length
    ? `{ ${required.map((name) => `${snippetKey(name)}: "..."`).join(", ")} }`
    : "{}";
  return `await ctx.mcp.${namespace}.${method}(${args});`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function SchemaBlock({ schema }: { schema: unknown }) {
  const json = prettySchema(schema);
  return (
    <div className="relative">
      <JsonSourceViewer source={json} height="220px" />
      <CopyIconButton value={json} label="Copy schema" className="absolute right-2 top-2" />
    </div>
  );
}

function ParametersSection({ operation }: { operation: ScriptConnectionOperation }) {
  const parameters = operation.parameters ?? [];
  if (!parameters.length) return null;
  return (
    <Section title="Parameters">
      <div className="rounded-md border">
        <div className="grid grid-cols-[1fr_90px_90px_1.2fr] gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs font-medium uppercase text-muted-foreground">
          <div>Name</div>
          <div>In</div>
          <div>Required</div>
          <div>Type</div>
        </div>
        <div className="divide-y">
          {parameters.map((parameter) => (
            <div
              key={`${parameter.in}:${parameter.name}`}
              className="grid grid-cols-[1fr_90px_90px_1.2fr] items-center gap-2 px-3 py-1.5 text-sm"
            >
              <div className="break-all font-mono text-xs">{parameter.name}</div>
              <div>
                <Badge variant="outline" size="tag">
                  {parameter.in}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                {parameter.required ? "yes" : "no"}
              </div>
              <div className="break-all font-mono text-xs text-muted-foreground">
                {schemaTypeLabel(parameter.schema)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function UsageSnippet({ snippet }: { snippet: string }) {
  return (
    <Section title="Use in a script">
      <div className="flex items-start justify-between gap-2 rounded-md border bg-muted/30 p-3">
        <pre className="min-w-0 flex-1 overflow-x-auto text-xs leading-5">{snippet}</pre>
        <CopyIconButton value={snippet} label="Copy snippet" />
      </div>
    </Section>
  );
}

/**
 * Detail modal for a single connection operation (OpenAPI) or tool (MCP):
 * request parameters / body / response schemas straight from the generated
 * runtime descriptors, plus a ready-to-paste ctx.api / ctx.mcp call snippet.
 */
export function OperationDetailDialog({
  open,
  onOpenChange,
  slug,
  subject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  subject: OperationDetailSubject | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto sm:max-w-2xl">
        {subject?.kind === "operation" ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge variant="outline" size="tag" className="font-mono">
                  {subject.operation.method}
                </Badge>
                <span className="break-all font-mono text-sm">{subject.operation.path}</span>
              </DialogTitle>
              <DialogDescription className="break-all text-left font-mono text-xs">
                {subject.operation.name}
              </DialogDescription>
            </DialogHeader>
            <ParametersSection operation={subject.operation} />
            {isNonEmptySchema(subject.operation.requestBodySchema) ? (
              <Section title="Request body">
                <SchemaBlock schema={subject.operation.requestBodySchema} />
              </Section>
            ) : null}
            {subject.operation.successStatus ||
            isNonEmptySchema(subject.operation.responseSchema) ? (
              <Section title="Response">
                {subject.operation.successStatus ? (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Success status</span>
                    <Badge variant="outline" size="tag">
                      {subject.operation.successStatus}
                    </Badge>
                  </div>
                ) : null}
                {isNonEmptySchema(subject.operation.responseSchema) ? (
                  <SchemaBlock schema={subject.operation.responseSchema} />
                ) : null}
              </Section>
            ) : null}
            <UsageSnippet snippet={operationSnippet(slug, subject.operation)} />
          </>
        ) : subject?.kind === "tool" ? (
          <>
            <DialogHeader>
              <DialogTitle className="break-all font-mono text-sm">{subject.tool.name}</DialogTitle>
              {subject.tool.description ? (
                <DialogDescription className="text-left">
                  {subject.tool.description}
                </DialogDescription>
              ) : null}
            </DialogHeader>
            {isNonEmptySchema(subject.tool.inputSchema) ? (
              <Section title="Input schema">
                <SchemaBlock schema={subject.tool.inputSchema} />
              </Section>
            ) : null}
            <UsageSnippet snippet={toolSnippet(slug, subject.tool)} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
