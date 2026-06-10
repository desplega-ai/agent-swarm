import type { ColDef } from "ag-grid-community";
import { GitMerge, Inbox, Search, UserPlus, Users } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useUnmapped, useUsers } from "@/api/hooks/use-users";
import type { User } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatRelative } from "@/lib/relative-time";
import { IdentityBadgeList } from "./identity-badges";
import { MergeModal } from "./merge-modal";
import { NewUserDialog } from "./new-user-dialog";
import { UnmappedTab } from "./unmapped/unmapped-tab";
import { BudgetBadge, UserStatusPill } from "./user-status";

/**
 * Tokenized substring match — every whitespace-separated query token must
 * appear (case-insensitive) somewhere in the haystack. Cheap, no fuzzy deps.
 */
function tokenMatch(haystack: string, query: string): boolean {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = haystack.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function buildHaystack(u: User): string {
  return [
    u.name,
    u.email ?? "",
    u.role ?? "",
    ...(u.emailAliases ?? []),
    ...(u.identities ?? []).flatMap((i) => [i.kind, i.externalId]),
  ].join(" ");
}

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
        field: "role",
        headerName: "Role",
        width: 160,
        cellRenderer: (params: { data: User | undefined }) => {
          if (!params.data) return null;
          const role = params.data.role?.trim();
          if (!role) return <span className="text-muted-foreground/60">—</span>;
          return <span className="text-sm capitalize">{role}</span>;
        },
      },
      {
        field: "identities",
        headerName: "Identities",
        flex: 1.4,
        minWidth: 220,
        cellRenderer: (params: { data: User | undefined }) => {
          if (!params.data) return null;
          return <IdentityBadgeList identities={params.data.identities} maxVisible={2} />;
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
              <TooltipContent>Enforced at task claim time for MCP-created tasks.</TooltipContent>
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
        field: "lastUpdatedAt",
        headerName: "Last update",
        width: 140,
        cellRenderer: (params: { value: string }) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground">{formatRelative(params.value)}</span>
            </TooltipTrigger>
            <TooltipContent className="font-mono text-[10px]">{params.value}</TooltipContent>
          </Tooltip>
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
      paginationQueryKey="people"
      onRowClicked={(e) => {
        if (e.data) onRowClick(e.data.id);
      }}
    />
  );
}

export default function PeoplePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { searchParams, setParam } = useUrlSearchState();

  // Tabs are URL-driven so deep-linking works (/people, /people/unmapped).
  const tab =
    readStringParam(searchParams, "tab") === "unmapped" || location.pathname.includes("/unmapped")
      ? "unmapped"
      : "people";

  const { data: users, isLoading } = useUsers();
  const { data: unmapped } = useUnmapped();
  const unmappedCount = unmapped?.length ?? 0;

  // Search is URL-backed and scoped to the People tab. Unmapped owns its own params.
  const query = readStringParam(searchParams, "q");
  const deferredQuery = useDeferredValue(query);

  const filteredUsers = useMemo(() => {
    if (!users) return undefined;
    const q = deferredQuery.trim();
    if (!q) return users;
    return users.filter((u) => tokenMatch(buildHaystack(u), q));
  }, [users, deferredQuery]);

  const [newUserOpen, setNewUserOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader
        title="People"
        description="Manage the humans who interact with this swarm — link their Slack, GitHub, Linear and GitLab accounts, set per-user budgets, and triage requests from accounts we haven't matched yet."
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
          const nextParams = new URLSearchParams(searchParams);
          if (next === "people") nextParams.delete("tab");
          else nextParams.set("tab", next);
          navigate(
            {
              pathname: next === "unmapped" ? "/people/unmapped" : "/people",
              search: nextParams.toString(),
            },
            { replace: true },
          );
        }}
        className="flex flex-col flex-1 min-h-0"
      >
        {/* Toolbar: People-tab search on the LEFT, tabs pinned to the FAR
            RIGHT via `ml-auto`. Search only renders while the People tab is
            active — the Unmapped tab owns its own search input. `ml-auto` on
            the tabs container guarantees right-alignment regardless of
            whether the search input is present or what width it takes. */}
        <div className="flex items-center gap-3 shrink-0">
          {tab === "people" && (
            <div className="relative flex-1 max-w-md min-w-0">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setParam("q", e.target.value, { reset: ["peoplePage"] })}
                placeholder="Search people, emails, aliases, identities…"
                className="pl-8 h-9"
              />
              {query && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                  {filteredUsers?.length ?? 0} / {users?.length ?? 0}
                </div>
              )}
            </div>
          )}

          <TabsList className="shrink-0 ml-auto">
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
        </div>

        <TabsContent value="people" className="flex-1 min-h-0 flex flex-col">
          <PeopleTable
            users={filteredUsers}
            isLoading={isLoading}
            onRowClick={(id) => navigate(`/people/${id}`)}
          />
        </TabsContent>

        <TabsContent value="unmapped" className="flex-1 min-h-0 flex flex-col">
          <UnmappedTab />
        </TabsContent>
      </Tabs>

      <NewUserDialog open={newUserOpen} onOpenChange={setNewUserOpen} />
      <MergeModal open={mergeOpen} onOpenChange={setMergeOpen} />
    </div>
  );
}
