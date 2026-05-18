import type { ColDef } from "ag-grid-community";
import { GitMerge, Inbox, UserPlus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useUnmapped, useUsers } from "@/api/hooks/use-users";
import type { User } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatSmartTime } from "@/lib/utils";
import { IdentityBadgeList } from "./identity-badges";
import { MergeModal } from "./merge-modal";
import { NewUserDialog } from "./new-user-dialog";
import { UnmappedTab } from "./unmapped/unmapped-tab";
import { BudgetBadge, EventIcon, UserStatusPill } from "./user-status";

function PeopleTable({
  users,
  isLoading,
  onRowClick,
}: {
  users: User[] | undefined;
  isLoading: boolean;
  onRowClick: (id: string) => void;
}) {
  const columnDefs = useMemo<ColDef<User>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 200,
        cellRenderer: (params: { value: string; data: User | undefined }) => {
          if (!params.data) return null;
          return (
            <div className="flex flex-col py-1 leading-tight">
              <span className="text-sm font-medium">{params.value}</span>
              {params.data.email && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-[11px] text-muted-foreground">{params.data.email}</span>
                  </TooltipTrigger>
                  {params.data.emailAliases && params.data.emailAliases.length > 0 && (
                    <TooltipContent>
                      <div className="text-xs font-medium mb-1">Aliases</div>
                      <ul className="space-y-0.5 font-mono text-[11px]">
                        {params.data.emailAliases.map((a) => (
                          <li key={a}>{a}</li>
                        ))}
                      </ul>
                    </TooltipContent>
                  )}
                </Tooltip>
              )}
            </div>
          );
        },
      },
      {
        field: "identities",
        headerName: "Identities",
        flex: 1.4,
        minWidth: 220,
        cellRenderer: (params: { data: User | undefined }) => {
          if (!params.data) return null;
          return <IdentityBadgeList identities={params.data.identities} />;
        },
      },
      {
        field: "dailyBudgetUsd",
        headerName: "Budget",
        width: 140,
        cellRenderer: (params: { data: User | undefined }) => {
          if (!params.data) return null;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <BudgetBadge value={params.data.dailyBudgetUsd} />
                </span>
              </TooltipTrigger>
              <TooltipContent>Enforced once MCP user-tokens ship.</TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        field: "status",
        headerName: "Status",
        width: 130,
        cellRenderer: (params: { data: User | undefined }) => {
          if (!params.data) return null;
          return <UserStatusPill status={params.data.status} />;
        },
      },
      {
        headerName: "Recent activity",
        flex: 1.2,
        minWidth: 220,
        cellRenderer: (params: { data: User | undefined }) => {
          if (!params.data) return null;
          const events = (params.data.recentEvents ?? []).slice(0, 2);
          if (events.length === 0)
            return <span className="text-xs italic text-muted-foreground/50">No events</span>;
          return (
            <div className="flex flex-col py-1 leading-tight gap-0.5">
              {events.map((e) => (
                <div key={e.id} className="flex items-center gap-1.5 text-[11px]">
                  <EventIcon eventType={e.eventType} />
                  <span className="font-mono uppercase text-[9px] text-muted-foreground">
                    {e.eventType.replaceAll("_", " ")}
                  </span>
                  <span className="text-muted-foreground">{formatSmartTime(e.createdAt)}</span>
                </div>
              ))}
            </div>
          );
        },
      },
      {
        field: "lastUpdatedAt",
        headerName: "Last update",
        width: 140,
        cellRenderer: (params: { value: string }) => (
          <span className="text-xs text-muted-foreground">{formatSmartTime(params.value)}</span>
        ),
      },
    ],
    [],
  );

  return (
    <DataGrid
      rowData={users}
      columnDefs={columnDefs}
      loading={isLoading}
      emptyMessage="No users yet — invite the first one with the New user button."
      onRowClicked={(e) => {
        if (e.data) onRowClick(e.data.id);
      }}
    />
  );
}

export default function PeoplePage() {
  const navigate = useNavigate();
  const location = useLocation();

  // Tabs are URL-driven so deep-linking works (/people, /people/unmapped).
  const initialTab = location.pathname.includes("/unmapped") ? "unmapped" : "people";
  const [tab, setTab] = useState<"people" | "unmapped">(initialTab);

  const { data: users, isLoading } = useUsers();
  const { data: unmapped } = useUnmapped();
  const unmappedCount = unmapped?.length ?? 0;

  const [newUserOpen, setNewUserOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="People"
        description="Operator surface for human users — identities, budgets, status, merge tool, and unmapped triage."
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setMergeOpen(true)}>
              <GitMerge className="h-4 w-4 mr-1.5" />
              Merge users
            </Button>
            <Button size="sm" onClick={() => setNewUserOpen(true)}>
              <UserPlus className="h-4 w-4 mr-1.5" />
              New user
            </Button>
          </div>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(v) => {
          const next = v === "unmapped" ? "unmapped" : "people";
          setTab(next);
          navigate(next === "unmapped" ? "/people/unmapped" : "/people", { replace: true });
        }}
        className="flex flex-col flex-1 min-h-0"
      >
        <TabsList className="shrink-0">
          <TabsTrigger value="people">
            <Users className="h-3.5 w-3.5 mr-1.5" />
            People ({users?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="unmapped">
            <Inbox className="h-3.5 w-3.5 mr-1.5" />
            Unmapped
            {unmappedCount > 0 && (
              <Badge
                variant="outline"
                size="tag"
                className="ml-1.5 border-status-warning/30 bg-status-warning/10 text-status-warning-strong"
              >
                {unmappedCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="people" className="flex-1 min-h-0 mt-4">
          <PeopleTable
            users={users}
            isLoading={isLoading}
            onRowClick={(id) => navigate(`/people/${id}`)}
          />
        </TabsContent>

        <TabsContent value="unmapped" className="flex-1 min-h-0 mt-4">
          <UnmappedTab />
        </TabsContent>
      </Tabs>

      <NewUserDialog open={newUserOpen} onOpenChange={setNewUserOpen} />
      <MergeModal open={mergeOpen} onOpenChange={setMergeOpen} />
    </div>
  );
}
