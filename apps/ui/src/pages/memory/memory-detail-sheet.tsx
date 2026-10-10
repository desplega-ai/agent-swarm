import { AlertTriangle, Brain, Trash2 } from "lucide-react";
import { Streamdown } from "streamdown";
import { useMemoryChunks } from "@/api/hooks/use-memory";
import type { MemoryChunk } from "@/api/types";
import { Spinner } from "@/components/kibo-ui/spinner";
import { CopyButton } from "@/components/shared/copy-button";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatTokens } from "@/lib/format-tokens";
import { formatSmartTime } from "@/lib/utils";

export interface MemoryDeleteTarget {
  id: string;
  name: string;
  /** The memory has other chunk rows that the delete leaves in place. */
  chunked: boolean;
}

/** Posterior mean as "0.72"; "—" on API servers that do not send it. */
export function formatRating(rating: number | undefined): string {
  return typeof rating === "number" ? rating.toFixed(2) : "—";
}

/**
 * The whole memory: every chunk row that shares the clicked row's key, in
 * chunkIndex order, with a warning when the rows present do not add up.
 */
export function MemoryDetailSheet({
  memoryId,
  onClose,
  agentName,
  onDelete,
}: {
  memoryId: string | null;
  onClose: () => void;
  agentName: (id: string | null) => string;
  onDelete: (target: MemoryDeleteTarget) => void;
}) {
  const { data, isLoading, error } = useMemoryChunks(memoryId);
  const chunks = data?.chunks ?? [];
  const anchor = chunks.find((c) => c.id === memoryId) ?? chunks[0];
  const first = chunks[0];
  const chunked = chunks.length > 1;
  const fullText = chunks.map((c) => c.content).join("\n\n");
  const usage = chunks.reduce((sum, c) => sum + c.accessCount, 0);
  const alpha = chunks.reduce((sum, c) => sum + c.alpha, 0);
  const beta = chunks.reduce((sum, c) => sum + c.beta, 0);
  const moved = chunks.some((c) => c.alpha !== 1 || c.beta !== 1);
  const updatedAt = chunks
    .map((c) => c.updatedAt ?? c.createdAt)
    .sort()
    .at(-1);

  return (
    <Sheet open={!!memoryId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[720px] sm:max-w-[720px] p-0">
        <div className="flex flex-col h-full">
          <SheetHeader className="px-6 py-4 border-b border-border">
            <SheetTitle className="flex items-center gap-2">
              <Brain className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{first?.name ?? "Memory"}</span>
            </SheetTitle>
            <SheetDescription className="font-mono text-xs break-all">
              {data?.key ?? memoryId}
            </SheetDescription>
            {first && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Badge variant="outline" size="tag">
                  {first.scope}
                </Badge>
                <Badge variant="outline" size="tag">
                  {first.source}
                </Badge>
                {first.tags.map((t) => (
                  <Badge key={t} variant="outline" size="tag">
                    {t}
                  </Badge>
                ))}
              </div>
            )}
          </SheetHeader>

          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6 py-4 space-y-4">
              {isLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="size-3.5" /> Loading memory…
                </div>
              )}
              {error && (
                <AlertCallout tone="error" icon={AlertTriangle}>
                  {error instanceof Error ? error.message : "Could not load this memory"}
                </AlertCallout>
              )}

              {data && !data.integrity.ok && (
                <AlertCallout
                  tone="warning"
                  icon={AlertTriangle}
                  title="These chunk rows do not add up"
                >
                  <ul className="list-disc pl-4 space-y-0.5">
                    {data.integrity.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                  <div className="mt-1.5 space-y-0.5 font-mono">
                    {chunks.map((c) => (
                      <div key={c.id}>
                        chunk {c.chunkIndex + 1} claims {c.totalChunks} · {c.id}
                      </div>
                    ))}
                  </div>
                </AlertCallout>
              )}

              {first && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
                  <Stat label="Usage" value={String(usage)} />
                  <Stat
                    label="Rating"
                    value={`${formatRating(alpha + beta > 0 ? alpha / (alpha + beta) : 0.5)}${moved ? "" : " (no ratings)"}`}
                  />
                  <Stat label="Est. tokens" value={formatTokens(data?.estTokens ?? 0)} />
                  <Stat label="Chunks" value={String(chunks.length)} />
                  <Stat label="Updated" value={updatedAt ? formatSmartTime(updatedAt) : "—"} />
                </div>
              )}

              {chunked && (
                <nav aria-label="Chunks" className="rounded-md border border-border">
                  {chunks.map((c) => (
                    <a
                      key={c.id}
                      href={`#chunk-${c.id}`}
                      className="flex items-center gap-3 px-3 py-1.5 text-xs hover:bg-muted/50 border-b border-border last:border-b-0"
                    >
                      <span className="font-mono text-muted-foreground w-12 shrink-0">
                        {c.chunkIndex + 1}/{c.totalChunks}
                      </span>
                      <span className="truncate flex-1">{c.name}</span>
                      <span className="text-muted-foreground shrink-0">
                        {formatTokens(c.estTokens)} tok
                      </span>
                    </a>
                  ))}
                </nav>
              )}

              {first && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                    Content
                  </div>
                  <div className="relative rounded-md border border-border bg-muted/30 px-3 py-2">
                    <CopyButton value={fullText} ariaLabel="Copy full memory" />
                    {chunks.map((c) => (
                      <ChunkBody key={c.id} chunk={c} showDivider={chunked} />
                    ))}
                  </div>
                </div>
              )}

              {anchor && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <DetailRow label="Agent" value={agentName(anchor.agentId)} />
                  <DetailRow label="Created" value={formatSmartTime(anchor.createdAt)} />
                  <DetailRow label="Last accessed" value={formatSmartTime(anchor.accessedAt)} />
                  <DetailRow label="Version" value={String(anchor.version)} />
                  {anchor.expiresAt && (
                    <DetailRow label="Expires" value={formatSmartTime(anchor.expiresAt)} />
                  )}
                  {anchor.embeddingModel && (
                    <DetailRow label="Embedding model" value={anchor.embeddingModel} />
                  )}
                  {anchor.sourceTaskId && (
                    <DetailRow label="Source task" value={anchor.sourceTaskId} mono />
                  )}
                  {anchor.sourcePath && (
                    <DetailRow label="Source path" value={anchor.sourcePath} mono />
                  )}
                  <DetailRow label="Memory id" value={anchor.id} mono />
                </div>
              )}
            </div>
          </ScrollArea>

          {anchor && (
            <div className="border-t border-border px-6 py-3 flex justify-end">
              <Button
                variant="destructive-outline"
                size="sm"
                className="gap-1.5"
                onClick={() => onDelete({ id: anchor.id, name: anchor.name, chunked })}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {chunked ? `Delete chunk ${anchor.chunkIndex + 1}` : "Delete memory"}
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ChunkBody({ chunk, showDivider }: { chunk: MemoryChunk; showDivider: boolean }) {
  return (
    <section id={`chunk-${chunk.id}`} className="scroll-mt-4">
      {showDivider && (
        <div className="flex items-center gap-2 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          <span className="font-mono">
            chunk {chunk.chunkIndex + 1}/{chunk.totalChunks}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <Streamdown>{chunk.content}</Streamdown>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

export function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={mono ? "font-mono text-xs break-all" : "text-sm"}>{value}</div>
    </div>
  );
}
