// mockup(ui-audit): secrets filter bar took 3 rows and the compact grid showed only a 200px-wide Key column
// Phone layout (below md) for Settings > Secrets: a full-width search, one row of
// [scope][Add], then MobileList rows with the whole key, a scope chip and the agent.
// It reuses `useSwarmConfigTable` and the section's dialogs, so a phone finds the
// same rows as the grid. Desktop keeps `SwarmConfigSection`.
import { Plus, Search, Trash2 } from "lucide-react";
import { Combobox } from "@/components/shared/combobox";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSwarmConfigTable } from "@/hooks/use-swarm-config";
import { ConfigDetailDialog } from "@/pages/config/components/config-detail-dialog";
import { ConfigEntryDialog } from "@/pages/config/components/config-entry-dialog";

export function SecretsMobileList() {
  const t = useSwarmConfigTable();

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search
          className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          placeholder="Search key, description, agent…"
          value={t.search}
          onChange={(e) => t.setSearch(e.target.value)}
          className="pl-8"
          aria-label="Search secrets"
        />
      </div>
      <div className="flex items-center gap-2">
        <Select value={t.scopeFilter} onValueChange={t.setScopeFilter}>
          <SelectTrigger className="flex-1" aria-label="Scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All scopes</SelectItem>
            <SelectItem value="global">Global</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
            <SelectItem value="repo">Repo</SelectItem>
          </SelectContent>
        </Select>
        {t.scopeFilter === "agent" && (
          <Combobox
            options={t.agentOptions}
            value={t.agentFilter}
            onChange={t.setAgentFilter}
            placeholder="All agents"
            searchPlaceholder="Search agents…"
            emptyMessage="No agents found"
            allowClear
            clearLabel="All agents"
            triggerClassName="flex-1 min-w-0"
          />
        )}
        <Button
          onClick={t.handleAdd}
          size="icon"
          className="shrink-0 bg-primary hover:bg-primary/90"
          aria-label="Add entry"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <MobileList
        label="Secrets"
        loading={t.isLoading}
        emptyMessage="No configuration entries"
        className="flex-none overflow-visible"
      >
        {t.filteredConfigs.map((cfg) => {
          const scopeName =
            cfg.scope === "agent" && cfg.scopeId
              ? (t.agentMap.get(cfg.scopeId) ?? `${cfg.scopeId.slice(0, 8)}…`)
              : cfg.scope === "repo" && cfg.scopeId
                ? `${cfg.scopeId.slice(0, 8)}…`
                : null;
          return (
            <MobileListRow
              key={cfg.id}
              onClick={() => t.setDetailEntry(cfg)}
              titleLines="full"
              title={<span className="font-mono text-[13px] break-all">{cfg.key}</span>}
              // Only agent / repo rows carry a chip, so a scoped override stands out.
              status={
                cfg.scope === "global" ? undefined : (
                  <Badge
                    variant="outline"
                    size="tag"
                    className="border-status-info/30 text-status-info-strong"
                  >
                    {cfg.scope}
                  </Badge>
                )
              }
              meta={[
                scopeName,
                cfg.isSecret ? "secret" : null,
                cfg.exportToEnv ? null : "server-only",
                cfg.description,
              ]}
              controls={[
                <Button
                  key="delete"
                  size="icon"
                  variant="ghost"
                  className="h-9 w-9 text-muted-foreground"
                  onClick={() => t.setDeleteTarget(cfg)}
                  aria-label={`Delete ${cfg.key}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>,
              ]}
            />
          );
        })}
      </MobileList>

      <ConfigDetailDialog
        config={t.detailEntry}
        onOpenChange={(open) => !open && t.setDetailEntry(null)}
        agentName={t.detailEntry?.scopeId ? t.agentMap.get(t.detailEntry.scopeId) : undefined}
        onEdit={(entry) => {
          t.setDetailEntry(null);
          t.handleEdit(entry);
        }}
      />

      <ConfigEntryDialog
        key={`${t.editEntry?.id ?? "new"}:${t.dialogSession}`}
        open={t.dialogOpen}
        onOpenChange={t.setDialogOpen}
        editEntry={t.editEntry}
        onSubmit={t.handleSubmit}
      />

      <AlertDialog
        open={!!t.deleteTarget}
        onOpenChange={(open) => !open && t.setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Config Entry</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{" "}
              <strong className="font-mono">{t.deleteTarget?.key}</strong>? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={t.handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
