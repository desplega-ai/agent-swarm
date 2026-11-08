import type { ColDef } from "ag-grid-community";
import { GitMerge, Inbox, Search, Send, UserPlus, Users } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useInvitesSupport } from "@/api/hooks/use-invites-support";
import { useUnmapped, useUsers } from "@/api/hooks/use-users";
import type { User } from "@/api/types";
import { DataGridColumnsMenu } from "@/components/shared/columns-menu";
import {
  DataGrid,
  type DataGridColumnsState,
  HIDE_WHEN_COMPACT,
  useDataGridColumns,
} from "@/components/shared/data-grid";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatRelative } from "@/lib/relative-time";
import { useIsAdmin } from "@/lib/use-can";
import { IdentityBadgeList } from "./identity-badges";
import { InviteDialog } from "./invite-dialog";
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
  columns,
}: {
  users: User[] | undefined;
  isLoading: boolean;
  onRowClick: (id: string) => void;
  columns: DataGridColumnsState;
}) {
  const isMobile = useIsMobile();
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
        context: HIDE_WHEN_COMPACT,
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
        context: HIDE_WHEN_COMPACT,
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
        context: HIDE_WHEN_COMPACT,
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
        context: HIDE_WHEN_COMPACT,
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

  // The grid clips every column but the first two at phone width; rows keep
  // the role and the identity count in view.
  if (isMobile) {
    return (
      <MobileList
        label="People"
        loading={isLoading}
        emptyMessage="No users yet. Add the first one with the New user button."
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {(users ?? []).map((user) => (
          <MobileListRow
            key={user.id}
            to={`/people/${user.id}`}
            title={user.name}
            titleLines={1}
            status={<UserStatusPill status={user.status} />}
            meta={[
              user.email,
              user.role ? (
                <span key="role" className="capitalize">
                  {user.role}
                </span>
              ) : null,
              user.identities?.length
                ? `${user.identities.length} identit${user.identities.length === 1 ? "y" : "ies"}`
                : null,
            ]}
          />
        ))}
      </MobileList>
    );
  }

  return (
    <DataGrid
      rowData={users}
      columnDefs={columnDefs}
      columns={columns}
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
  const gridColumns = useDataGridColumns("people");
  const navigate = useNavigate();
  const location = useLocation();
  const { searchParams, setParam } = useUrlSearchState();

  // Tabs are URL-driven so deep-linking works (/people, /people/unmapped).
  const tab =
    readStringParam(searchParams, "tab") === "unmapped" || location.pathname.includes("/unmapped")
      ? "unmapped"
      : "people";

  const isMobile = useIsMobile();
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
  const [inviteOpen, setInviteOpen] = useState(false);
  // Invites assign a role: admins only, on an API that serves them.
  const isAdmin = useIsAdmin();
  const invitesSupported = useInvitesSupport();
  const canInvite = isAdmin && invitesSupported;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="People" />

      <Tabs
        value={tab}
        onValueChange={(v) => {
          const next = v === "unmapped" ? "unmapped" : "people";
          const nextParams = new URLSearchParams(searchParams);
          if (next === "people") nextParams.delete("tab");
          else nextParams.set("tab", next);
          void navigate(
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 shrink-0 md:flex-nowrap">
          {tab === "people" && (
            <div className="relative min-w-0 flex-1 basis-full max-md:order-last md:max-w-md md:basis-40">
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

          <TabsList className="shrink-0 max-md:min-w-0 max-md:flex-1 md:ml-auto">
            <TabsTrigger value="people" className="max-md:flex-1">
              <Users className="mr-1.5 h-3.5 w-3.5 max-md:hidden" />
              People ({users?.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="unmapped" className="max-md:flex-1">
              <Inbox className="mr-1.5 h-3.5 w-3.5 max-md:hidden" />
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
          {tab === "people" && !isMobile ? <DataGridColumnsMenu state={gridColumns} /> : null}
          {/* Page actions ride the toolbar, right of the tabs — no lone
              header action row. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="size-8 shrink-0"
                onClick={() => setMergeOpen(true)}
                aria-label="Merge users"
              >
                <GitMerge className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Merge users</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                className="size-8 shrink-0"
                onClick={() => setNewUserOpen(true)}
                aria-label="New user"
              >
                <UserPlus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New user</TooltipContent>
          </Tooltip>
          {canInvite ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => setInviteOpen(true)}
            >
              <Send />
              <span className="max-md:sr-only">Invite</span>
            </Button>
          ) : null}
        </div>

        <TabsContent value="people" className="flex-1 min-h-0 flex flex-col">
          <PeopleTable
            users={filteredUsers}
            isLoading={isLoading}
            columns={gridColumns}
            onRowClick={(id) => navigate(`/people/${id}`)}
          />
        </TabsContent>

        <TabsContent value="unmapped" className="flex-1 min-h-0 flex flex-col">
          <UnmappedTab />
        </TabsContent>
      </Tabs>

      <NewUserDialog open={newUserOpen} onOpenChange={setNewUserOpen} />
      {canInvite ? <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} /> : null}
      <MergeModal open={mergeOpen} onOpenChange={setMergeOpen} />
    </div>
  );
}
