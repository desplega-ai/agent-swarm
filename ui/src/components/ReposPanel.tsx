import Box from "@mui/joy/Box";
import Button from "@mui/joy/Button";
import Card from "@mui/joy/Card";
import Checkbox from "@mui/joy/Checkbox";
import Input from "@mui/joy/Input";
import { useColorScheme } from "@mui/joy/styles";
import Table from "@mui/joy/Table";
import Typography from "@mui/joy/Typography";
import { useCallback, useState } from "react";
import { useCreateRepo, useDeleteRepo, useRepos, useUpdateRepo } from "../hooks/queries";
import type { SwarmRepo } from "../types/api";

function RepoForm({
  editingRepo,
  onSubmit,
  onCancel,
}: {
  editingRepo: SwarmRepo | null;
  onSubmit: (data: {
    url: string;
    name: string;
    clonePath?: string;
    defaultBranch?: string;
    autoClone?: boolean;
  }) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState(editingRepo?.url ?? "");
  const [name, setName] = useState(editingRepo?.name ?? "");
  const [clonePath, setClonePath] = useState(editingRepo?.clonePath ?? "");
  const [defaultBranch, setDefaultBranch] = useState(editingRepo?.defaultBranch ?? "main");
  const [autoClone, setAutoClone] = useState(editingRepo?.autoClone ?? true);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !name.trim()) return;
    onSubmit({
      url: url.trim(),
      name: name.trim(),
      clonePath: clonePath.trim() || undefined,
      defaultBranch: defaultBranch.trim() || "main",
      autoClone,
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
        {editingRepo ? "Edit Repo" : "Add Repo"}
      </Typography>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <Input
          size="sm"
          placeholder="https://github.com/org/repo"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={!!editingRepo}
          sx={{ flex: 2, minWidth: 250, fontFamily: "code" }}
          required
        />
        <Input
          size="sm"
          placeholder="repo-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          sx={{ flex: 1, minWidth: 150, fontFamily: "code" }}
          required
        />
      </Box>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
        <Input
          size="sm"
          placeholder="/workspace/repos/repo-name (default)"
          value={clonePath}
          onChange={(e) => setClonePath(e.target.value)}
          sx={{ flex: 2, minWidth: 250, fontFamily: "code" }}
        />
        <Input
          size="sm"
          placeholder="main"
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          sx={{ flex: 1, minWidth: 100, fontFamily: "code" }}
        />
        <Checkbox
          size="sm"
          label="Auto-clone"
          checked={autoClone}
          onChange={(e) => setAutoClone(e.target.checked)}
        />
      </Box>
      <Box sx={{ display: "flex", gap: 1 }}>
        <Button type="submit" size="sm" variant="solid" color="primary">
          {editingRepo ? "Update" : "Add"}
        </Button>
        <Button size="sm" variant="plain" color="neutral" onClick={onCancel}>
          Cancel
        </Button>
      </Box>
    </Box>
  );
}

export default function ReposPanel() {
  const [showForm, setShowForm] = useState(false);
  const [editingRepo, setEditingRepo] = useState<SwarmRepo | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { data: repos, isLoading } = useRepos();
  const createMutation = useCreateRepo();
  const updateMutation = useUpdateRepo();
  const deleteMutation = useDeleteRepo();
  const { mode } = useColorScheme();
  const isDark = mode === "dark";

  const colors = {
    amber: isDark ? "#F5A623" : "#D48806",
    headerBg: isDark ? "rgba(245, 166, 35, 0.06)" : "rgba(212, 136, 6, 0.04)",
  };

  const handleSubmit = useCallback(
    (data: {
      url: string;
      name: string;
      clonePath?: string;
      defaultBranch?: string;
      autoClone?: boolean;
    }) => {
      if (editingRepo) {
        updateMutation.mutate(
          { id: editingRepo.id, data },
          {
            onSuccess: () => {
              setShowForm(false);
              setEditingRepo(null);
            },
          },
        );
      } else {
        createMutation.mutate(data, {
          onSuccess: () => {
            setShowForm(false);
          },
        });
      }
    },
    [editingRepo, createMutation, updateMutation],
  );

  const handleEdit = useCallback((repo: SwarmRepo) => {
    setEditingRepo(repo);
    setShowForm(true);
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      if (deletingId === id) {
        deleteMutation.mutate(id);
        setDeletingId(null);
      } else {
        setDeletingId(id);
      }
    },
    [deletingId, deleteMutation],
  );

  const handleCancel = useCallback(() => {
    setShowForm(false);
    setEditingRepo(null);
  }, []);

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
          justifyContent: "space-between",
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
          {">"} REPOS
        </Typography>
        <Typography level="body-xs" sx={{ color: "text.tertiary", fontFamily: "code" }}>
          {repos?.length ?? 0} registered
        </Typography>
      </Box>

      {/* Content */}
      <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 2 }}>
        {isLoading && (
          <Typography level="body-sm" sx={{ p: 2, color: "text.tertiary" }}>
            Loading...
          </Typography>
        )}

        {!isLoading && (!repos || repos.length === 0) && (
          <Box sx={{ p: 3, textAlign: "center" }}>
            <Typography level="body-sm" sx={{ color: "text.tertiary" }}>
              No repos registered. Add one to enable auto-clone and CLAUDE.md injection.
            </Typography>
          </Box>
        )}

        {!isLoading && repos && repos.length > 0 && (
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
                <th style={{ width: "15%" }}>Name</th>
                <th style={{ width: "30%" }}>URL</th>
                <th style={{ width: "25%" }}>Clone Path</th>
                <th style={{ width: "8%" }}>Branch</th>
                <th style={{ width: "10%" }}>Auto-Clone</th>
                <th style={{ width: "12%" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => (
                <tr key={repo.id}>
                  <td>
                    <Typography level="body-sm" sx={{ fontFamily: "code", fontWeight: 600 }}>
                      {repo.name}
                    </Typography>
                  </td>
                  <td>
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
                      {repo.url}
                    </Typography>
                  </td>
                  <td>
                    <Typography
                      level="body-xs"
                      sx={{
                        fontFamily: "code",
                        color: "text.tertiary",
                        maxWidth: 250,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {repo.clonePath}
                    </Typography>
                  </td>
                  <td>
                    <Typography level="body-xs" sx={{ fontFamily: "code", color: "text.tertiary" }}>
                      {repo.defaultBranch}
                    </Typography>
                  </td>
                  <td>
                    <Typography
                      level="body-xs"
                      sx={{ color: repo.autoClone ? "success.plainColor" : "text.tertiary" }}
                    >
                      {repo.autoClone ? "yes" : "no"}
                    </Typography>
                  </td>
                  <td>
                    <Box sx={{ display: "flex", gap: 0.5 }}>
                      <Button
                        size="sm"
                        variant="plain"
                        color="neutral"
                        onClick={() => handleEdit(repo)}
                      >
                        edit
                      </Button>
                      <Button
                        size="sm"
                        variant="plain"
                        color={deletingId === repo.id ? "danger" : "neutral"}
                        onClick={() => handleDelete(repo.id)}
                      >
                        {deletingId === repo.id ? "confirm?" : "del"}
                      </Button>
                    </Box>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        {showForm ? (
          <RepoForm editingRepo={editingRepo} onSubmit={handleSubmit} onCancel={handleCancel} />
        ) : (
          <Box sx={{ px: 2 }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={() => {
                setEditingRepo(null);
                setShowForm(true);
              }}
            >
              + Add Repo
            </Button>
          </Box>
        )}
      </Box>
    </Card>
  );
}
