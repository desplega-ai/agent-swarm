import Box from "@mui/joy/Box";
import Button from "@mui/joy/Button";
import Card from "@mui/joy/Card";
import Checkbox from "@mui/joy/Checkbox";
import IconButton from "@mui/joy/IconButton";
import Input from "@mui/joy/Input";
import Option from "@mui/joy/Option";
import Select from "@mui/joy/Select";
import { useColorScheme } from "@mui/joy/styles";
import Tab from "@mui/joy/Tab";
import TabList from "@mui/joy/TabList";
import TabPanel from "@mui/joy/TabPanel";
import Table from "@mui/joy/Table";
import Tabs from "@mui/joy/Tabs";
import Typography from "@mui/joy/Typography";
import { useCallback, useState } from "react";
import { useAgents, useConfigs, useDeleteConfig, useUpsertConfig } from "../hooks/queries";
import type { SwarmConfig, SwarmConfigScope } from "../types/api";

function ConfigTable({
  configs,
  onEdit,
  onDelete,
}: {
  configs: SwarmConfig[];
  onEdit: (config: SwarmConfig) => void;
  onDelete: (id: string) => void;
}) {
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const toggleReveal = (id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleDelete = (id: string) => {
    if (deletingId === id) {
      onDelete(id);
      setDeletingId(null);
    } else {
      setDeletingId(id);
    }
  };

  if (configs.length === 0) {
    return (
      <Box sx={{ p: 3, textAlign: "center" }}>
        <Typography level="body-sm" sx={{ color: "text.tertiary" }}>
          No config entries found. Add one using the form below.
        </Typography>
      </Box>
    );
  }

  return (
    <Table
      size="sm"
      sx={{
        "& th": {
          fontFamily: "code",
          fontSize: "0.7rem",
          letterSpacing: "0.05em",
          color: "text.tertiary",
          textTransform: "uppercase",
        },
        "& td": {
          fontFamily: "code",
          fontSize: "0.8rem",
        },
      }}
    >
      <thead>
        <tr>
          <th style={{ width: "20%" }}>Key</th>
          <th style={{ width: "30%" }}>Value</th>
          <th style={{ width: "20%" }}>Description</th>
          <th style={{ width: "10%" }}>Scope ID</th>
          <th style={{ width: "8%" }}>Secret</th>
          <th style={{ width: "12%" }}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {configs.map((config) => (
          <tr key={config.id}>
            <td>
              <Typography level="body-sm" sx={{ fontFamily: "code", fontWeight: 600 }}>
                {config.key}
              </Typography>
            </td>
            <td>
              {config.isSecret ? (
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                  <Typography
                    level="body-sm"
                    sx={{ fontFamily: "code", color: "text.secondary" }}
                  >
                    {revealedIds.has(config.id) ? config.value : "********"}
                  </Typography>
                  <IconButton
                    size="sm"
                    variant="plain"
                    onClick={() => toggleReveal(config.id)}
                    sx={{ minWidth: 24, minHeight: 24, fontSize: "0.7rem" }}
                  >
                    {revealedIds.has(config.id) ? "hide" : "show"}
                  </IconButton>
                </Box>
              ) : (
                <Typography
                  level="body-sm"
                  sx={{
                    fontFamily: "code",
                    color: "text.secondary",
                    maxWidth: 300,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {config.value}
                </Typography>
              )}
            </td>
            <td>
              <Typography
                level="body-xs"
                sx={{
                  color: "text.tertiary",
                  maxWidth: 200,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {config.description || "—"}
              </Typography>
            </td>
            <td>
              <Typography level="body-xs" sx={{ fontFamily: "code", color: "text.tertiary" }}>
                {config.scopeId ? config.scopeId.slice(0, 8) : "—"}
              </Typography>
            </td>
            <td>
              <Typography level="body-xs" sx={{ color: "text.tertiary" }}>
                {config.isSecret ? "yes" : "no"}
              </Typography>
            </td>
            <td>
              <Box sx={{ display: "flex", gap: 0.5 }}>
                <Button size="sm" variant="plain" color="neutral" onClick={() => onEdit(config)}>
                  edit
                </Button>
                <Button
                  size="sm"
                  variant="plain"
                  color={deletingId === config.id ? "danger" : "neutral"}
                  onClick={() => handleDelete(config.id)}
                >
                  {deletingId === config.id ? "confirm?" : "del"}
                </Button>
              </Box>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ConfigForm({
  scope,
  scopeId,
  editingConfig,
  onSubmit,
  onCancel,
}: {
  scope: SwarmConfigScope;
  scopeId?: string;
  editingConfig: SwarmConfig | null;
  onSubmit: (data: {
    scope: string;
    scopeId?: string | null;
    key: string;
    value: string;
    isSecret?: boolean;
    envPath?: string | null;
    description?: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const [key, setKey] = useState(editingConfig?.key ?? "");
  const [value, setValue] = useState(editingConfig?.value ?? "");
  const [isSecret, setIsSecret] = useState(editingConfig?.isSecret ?? false);
  const [envPath, setEnvPath] = useState(editingConfig?.envPath ?? "");
  const [description, setDescription] = useState(editingConfig?.description ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim() || value === undefined) return;
    onSubmit({
      scope,
      scopeId: scope === "global" ? null : scopeId || null,
      key: key.trim(),
      value,
      isSecret,
      envPath: envPath.trim() || null,
      description: description.trim() || null,
    });
  };

  return (
    <Box
      component="form"
      onSubmit={handleSubmit}
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 1.5,
        p: 2,
        border: "1px solid",
        borderColor: "neutral.outlinedBorder",
        borderRadius: "sm",
      }}
    >
      <Typography level="title-sm" sx={{ fontFamily: "code" }}>
        {editingConfig ? "Edit Config Entry" : "Add Config Entry"}
      </Typography>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <Input
          size="sm"
          placeholder="KEY_NAME"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          disabled={!!editingConfig}
          sx={{ flex: 1, minWidth: 150, fontFamily: "code" }}
          required
        />
        <Input
          size="sm"
          placeholder="value"
          type={isSecret ? "password" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          sx={{ flex: 2, minWidth: 200, fontFamily: "code" }}
          required
        />
      </Box>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
        <Input
          size="sm"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          sx={{ flex: 2, minWidth: 200 }}
        />
        <Input
          size="sm"
          placeholder="envPath (optional)"
          value={envPath}
          onChange={(e) => setEnvPath(e.target.value)}
          sx={{ flex: 1, minWidth: 150, fontFamily: "code" }}
        />
        <Checkbox
          size="sm"
          label="Secret"
          checked={isSecret}
          onChange={(e) => setIsSecret(e.target.checked)}
        />
      </Box>
      <Box sx={{ display: "flex", gap: 1 }}>
        <Button type="submit" size="sm" variant="solid" color="primary">
          {editingConfig ? "Update" : "Add"}
        </Button>
        <Button size="sm" variant="plain" color="neutral" onClick={onCancel}>
          Cancel
        </Button>
      </Box>
    </Box>
  );
}

function ScopedConfigSection({
  scope,
  scopeId,
}: {
  scope: SwarmConfigScope;
  scopeId?: string;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingConfig, setEditingConfig] = useState<SwarmConfig | null>(null);
  const { data: configs, isLoading } = useConfigs({
    scope,
    scopeId: scope === "global" ? undefined : scopeId,
    includeSecrets: true,
  });
  const upsertMutation = useUpsertConfig();
  const deleteMutation = useDeleteConfig();

  const handleSubmit = useCallback(
    (data: {
      scope: string;
      scopeId?: string | null;
      key: string;
      value: string;
      isSecret?: boolean;
      envPath?: string | null;
      description?: string | null;
    }) => {
      upsertMutation.mutate(data, {
        onSuccess: () => {
          setShowForm(false);
          setEditingConfig(null);
        },
      });
    },
    [upsertMutation],
  );

  const handleEdit = useCallback((config: SwarmConfig) => {
    setEditingConfig(config);
    setShowForm(true);
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      deleteMutation.mutate(id);
    },
    [deleteMutation],
  );

  const handleCancel = useCallback(() => {
    setShowForm(false);
    setEditingConfig(null);
  }, []);

  // Don't render for agent/repo scope without a scopeId selected
  if (scope !== "global" && !scopeId) {
    return (
      <Box sx={{ p: 3, textAlign: "center" }}>
        <Typography level="body-sm" sx={{ color: "text.tertiary" }}>
          Select {scope === "agent" ? "an agent" : "a repo"} to view its config entries.
        </Typography>
      </Box>
    );
  }

  if (isLoading) {
    return (
      <Typography level="body-sm" sx={{ p: 2, color: "text.tertiary" }}>
        Loading...
      </Typography>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <ConfigTable configs={configs ?? []} onEdit={handleEdit} onDelete={handleDelete} />

      {showForm ? (
        <ConfigForm
          scope={scope}
          scopeId={scopeId}
          editingConfig={editingConfig}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      ) : (
        <Box sx={{ px: 2 }}>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={() => {
              setEditingConfig(null);
              setShowForm(true);
            }}
          >
            + Add Entry
          </Button>
        </Box>
      )}
    </Box>
  );
}

export default function ConfigPanel() {
  const [scopeTab, setScopeTab] = useState<SwarmConfigScope>("global");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [repoId, setRepoId] = useState<string>("");
  const { data: agents } = useAgents();
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    headerBg: isDark ? "rgba(245, 166, 35, 0.06)" : "rgba(212, 136, 6, 0.04)",
  };

  return (
    <Card
      variant="outlined"
      sx={{
        height: "100%",
        overflow: "auto",
        borderColor: "neutral.outlinedBorder",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          px: 2.5,
          py: 1.5,
          borderBottom: "1px solid",
          borderColor: "neutral.outlinedBorder",
          bgcolor: colors.headerBg,
          display: "flex",
          alignItems: "center",
          gap: 1.5,
        }}
      >
        <Typography
          sx={{
            fontFamily: "code",
            fontSize: "0.9rem",
            fontWeight: 700,
            color: colors.amber,
          }}
        >
          {">"} SWARM CONFIG
        </Typography>
      </Box>

      {/* Scope Tabs */}
      <Box sx={{ p: 2 }}>
        <Tabs
          value={scopeTab}
          onChange={(_, v) => setScopeTab(v as SwarmConfigScope)}
          sx={{ bgcolor: "transparent" }}
        >
          <TabList
            size="sm"
            sx={{
              gap: 0.5,
              bgcolor: "transparent",
              "& .MuiTab-root": {
                fontFamily: "code",
                fontSize: "0.75rem",
                letterSpacing: "0.03em",
                fontWeight: 600,
              },
            }}
          >
            <Tab value="global">Global</Tab>
            <Tab value="agent">Per-Agent</Tab>
            <Tab value="repo">Per-Repo</Tab>
          </TabList>

          <TabPanel value="global" sx={{ p: 0, pt: 2 }}>
            <ScopedConfigSection scope="global" />
          </TabPanel>

          <TabPanel value="agent" sx={{ p: 0, pt: 2 }}>
            <Box sx={{ mb: 2 }}>
              <Select
                size="sm"
                placeholder="Select an agent..."
                value={selectedAgentId || null}
                onChange={(_, v) => setSelectedAgentId(v as string)}
                sx={{ maxWidth: 400, fontFamily: "code" }}
              >
                {(agents ?? []).map((agent) => (
                  <Option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.id.slice(0, 8)})
                  </Option>
                ))}
              </Select>
            </Box>
            <ScopedConfigSection scope="agent" scopeId={selectedAgentId || undefined} />
          </TabPanel>

          <TabPanel value="repo" sx={{ p: 0, pt: 2 }}>
            <Box sx={{ mb: 2 }}>
              <Input
                size="sm"
                placeholder="Enter repo identifier..."
                value={repoId}
                onChange={(e) => setRepoId(e.target.value)}
                sx={{ maxWidth: 400, fontFamily: "code" }}
              />
            </Box>
            <ScopedConfigSection scope="repo" scopeId={repoId || undefined} />
          </TabPanel>
        </Tabs>
      </Box>
    </Card>
  );
}
