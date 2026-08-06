import type { ColDef, ICellRendererParams, RowClickedEvent } from "ag-grid-community";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { useCreateMcpServer, useMcpServers } from "@/api/hooks";
import type { McpServer } from "@/api/types";
import { DataGrid } from "@/components/shared/data-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatRelativeTime } from "@/lib/utils";

const TRANSPORT_VALUES = ["stdio", "http", "sse"] as const;

/**
 * Minimal create dialog. Supports deep-link prefill via query params:
 * /mcp-servers?new=1&name=<name>&url=<url>&transport=http (used by the
 * Connections page MCP guidance flow).
 */
function AddMcpServerDialog({
  open,
  onOpenChange,
  initialName,
  initialUrl,
  initialTransport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName: string;
  initialUrl: string;
  initialTransport: string;
}) {
  const navigate = useNavigate();
  const create = useCreateMcpServer();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<string>("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [headers, setHeaders] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setTransport(
      (TRANSPORT_VALUES as readonly string[]).includes(initialTransport)
        ? initialTransport
        : "http",
    );
    setUrl(initialUrl);
    setCommand("");
    setHeaders("");
  }, [open, initialName, initialUrl, initialTransport]);

  async function submit() {
    try {
      const { server } = await create.mutateAsync({
        name: name.trim(),
        transport,
        ...(transport === "stdio" ? { command: command.trim() } : { url: url.trim() }),
        ...(transport !== "stdio" && headers.trim() ? { headers: headers.trim() } : {}),
      });
      toast.success(`MCP server ${server.name} created`);
      onOpenChange(false);
      navigate(`/mcp-servers/${server.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  const canSubmit = Boolean(name.trim() && (transport === "stdio" ? command.trim() : url.trim()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="pb-2">
          <DialogTitle>Add MCP Server</DialogTitle>
          <DialogDescription>
            Register an MCP server so agents and script connections can use its tools.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="stripe"
              />
            </div>
            <div className="space-y-2">
              <Label>Transport</Label>
              <Select value={transport} onValueChange={setTransport}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSPORT_VALUES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {transport === "stdio" ? (
            <div className="space-y-2">
              <Label>Command</Label>
              <Input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="npx -y @modelcontextprotocol/server-github"
              />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>URL</Label>
                <Input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://mcp.stripe.com"
                />
              </div>
              <div className="space-y-2">
                <Label>Headers (optional, JSON)</Label>
                <Textarea
                  value={headers}
                  onChange={(event) => setHeaders(event.target.value)}
                  className="min-h-20 font-mono text-xs"
                  placeholder={`{"Authorization": "Bearer <token>"}`}
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || create.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Transport / auth-method / scope chips. Each protocol type has no semantic
 * status meaning — they're visual differentiators. Mapped by closest hue match
 * to existing action / status tokens (pixel parity preserved):
 * - stdio (blue) → `action-default`
 * - http (purple) → `action-delegate-to-agent`
 * - sse (cyan) → `action-script`
 * - oauth (purple) → `action-delegate-to-agent`
 * - auto (sky) → `action-raw-llm`
 * - global (emerald) → `status-success`
 * - swarm (amber) → `status-active`
 */
function TransportBadge({ transport }: { transport: string }) {
  const colors: Record<string, string> = {
    stdio: "border-action-default/30 text-action-default",
    http: "border-action-delegate-to-agent/30 text-action-delegate-to-agent",
    sse: "border-action-script/30 text-action-script",
  };
  return (
    <Badge variant="outline" size="tag" className={`${colors[transport] || ""}`}>
      {transport}
    </Badge>
  );
}

function AuthMethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    static: "border-status-neutral/30 text-status-neutral-strong",
    oauth: "border-action-delegate-to-agent/30 text-action-delegate-to-agent",
    auto: "border-action-raw-llm/30 text-action-raw-llm",
  };
  return (
    <Badge variant="outline" size="tag" className={`${colors[method] || ""}`}>
      {method}
    </Badge>
  );
}

function ScopeBadge({ scope }: { scope: string }) {
  const colors: Record<string, string> = {
    global: "border-status-success/30 text-status-success-strong",
    swarm: "border-status-active/30 text-status-active-strong",
    agent: "border-status-neutral/30 text-status-neutral-strong",
  };
  return (
    <Badge variant="outline" size="tag" className={`${colors[scope] || ""}`}>
      {scope}
    </Badge>
  );
}

export default function McpServersPage() {
  const navigate = useNavigate();
  const { searchParams, setParam } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  const scopeFilter = readStringParam(searchParams, "scope", "all");
  const transportFilter = readStringParam(searchParams, "transport", "all");
  const newParam = readStringParam(searchParams, "new");
  const prefillName = readStringParam(searchParams, "name");
  const prefillUrl = readStringParam(searchParams, "url");
  // The deep-link `transport` param doubles as the table filter; only treat it
  // as a prefill when the create dialog is requested via ?new=1.
  const prefillTransport = newParam ? readStringParam(searchParams, "transport") : "";

  const setCreateOpen = useCallback(
    (open: boolean) => {
      setParam("new", open ? "1" : "", { reset: open ? [] : ["name", "url", "transport"] });
    },
    [setParam],
  );

  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    if (scopeFilter !== "all") f.scope = scopeFilter;
    if (transportFilter !== "all") f.transport = transportFilter;
    return Object.keys(f).length > 0 ? f : undefined;
  }, [scopeFilter, transportFilter]);

  const { data, isLoading } = useMcpServers(filters);
  const servers = data?.servers ?? [];

  const columnDefs = useMemo<ColDef<McpServer>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 150,
        cellRenderer: (params: ICellRendererParams<McpServer>) => (
          <span className="font-medium">{params.value}</span>
        ),
      },
      {
        field: "transport",
        headerName: "Transport",
        width: 100,
        cellRenderer: (params: ICellRendererParams<McpServer>) =>
          params.value ? <TransportBadge transport={params.value} /> : null,
      },
      {
        field: "scope",
        headerName: "Scope",
        width: 100,
        cellRenderer: (params: ICellRendererParams<McpServer>) =>
          params.value ? <ScopeBadge scope={params.value} /> : null,
      },
      {
        field: "authMethod",
        headerName: "Auth",
        width: 90,
        cellRenderer: (params: ICellRendererParams<McpServer>) =>
          params.value ? <AuthMethodBadge method={params.value} /> : null,
      },
      {
        field: "description",
        headerName: "Description",
        flex: 2,
        minWidth: 200,
      },
      {
        field: "isEnabled",
        headerName: "Status",
        width: 90,
        cellRenderer: (params: ICellRendererParams<McpServer>) => (
          <Badge
            variant="outline"
            size="tag"
            className={`${
              params.value
                ? "border-status-success/30 text-status-success-strong"
                : "border-status-error/30 text-status-error-strong"
            }`}
          >
            {params.value ? "Enabled" : "Disabled"}
          </Badge>
        ),
      },
      {
        field: "createdAt",
        headerName: "Created",
        width: 140,
        valueFormatter: (params) => (params.value ? formatRelativeTime(params.value) : "-"),
      },
    ],
    [],
  );

  const onRowClicked = useCallback(
    (event: RowClickedEvent<McpServer>) => {
      if (event.data) navigate(`/mcp-servers/${event.data.id}`);
    },
    [navigate],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="MCP Servers" className="shrink-0" />

      <div className="flex items-center gap-3 shrink-0">
        <Input
          placeholder="Search servers..."
          value={search}
          onChange={(e) => setParam("search", e.target.value, { reset: ["mcpServersPage"] })}
          className="max-w-xs"
        />
        <Select
          value={transportFilter}
          onValueChange={(value) =>
            setParam("transport", value, {
              defaultValue: "all",
              reset: ["mcpServersPage"],
            })
          }
        >
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Transport" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Transports</SelectItem>
            <SelectItem value="stdio">stdio</SelectItem>
            <SelectItem value="http">http</SelectItem>
            <SelectItem value="sse">sse</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={scopeFilter}
          onValueChange={(value) =>
            setParam("scope", value, {
              defaultValue: "all",
              reset: ["mcpServersPage"],
            })
          }
        >
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Scope" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Scopes</SelectItem>
            <SelectItem value="global">Global</SelectItem>
            <SelectItem value="swarm">Swarm</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
          </SelectContent>
        </Select>
        {/* Add lives in the toolbar as a bare "+" — no lone header action row. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              className="size-8 ml-auto"
              onClick={() => setCreateOpen(true)}
              aria-label="Add server"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add server</TooltipContent>
        </Tooltip>
      </div>

      <DataGrid
        rowData={servers}
        columnDefs={columnDefs}
        quickFilterText={search}
        onRowClicked={onRowClicked}
        loading={isLoading}
        emptyMessage="No MCP servers found"
        paginationQueryKey="mcpServers"
      />

      <AddMcpServerDialog
        open={Boolean(newParam)}
        onOpenChange={setCreateOpen}
        initialName={prefillName}
        initialUrl={prefillUrl}
        initialTransport={prefillTransport}
      />
    </div>
  );
}
