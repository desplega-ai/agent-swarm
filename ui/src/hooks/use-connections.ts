import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useConfig } from "@/hooks/use-config";
import type { Connection } from "@/lib/config";

export interface ConnectionFormData {
  name: string;
  apiUrl: string;
  apiKey: string;
}

export function useConnections() {
  const {
    connections,
    activeConnection,
    switchConnection,
    addConnection,
    updateConnection,
    removeConnection,
    resetConfig,
  } = useConfig();
  const navigate = useNavigate();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Connection | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Connection | null>(null);

  function handleAdd() {
    setEditTarget(null);
    setDialogOpen(true);
  }

  function handleEdit(conn: Connection) {
    setEditTarget(conn);
    setDialogOpen(true);
  }

  function handleSubmit(data: ConnectionFormData) {
    if (editTarget) {
      updateConnection(editTarget.id, {
        name: data.name,
        apiUrl: data.apiUrl,
        apiKey: data.apiKey,
      });
    } else {
      const created = addConnection({
        name: data.name,
        apiUrl: data.apiUrl,
        apiKey: data.apiKey,
      });
      if (connections.length === 0) {
        switchConnection(created.id);
        navigate("/");
      }
    }
    setEditTarget(null);
  }

  function handleDelete() {
    if (!deleteTarget) return;

    if (connections.length === 1) {
      resetConfig();
      setDeleteTarget(null);
      return;
    }

    if (activeConnection?.id === deleteTarget.id) {
      const other = connections.find((c) => c.id !== deleteTarget.id);
      if (other) switchConnection(other.id);
    }

    removeConnection(deleteTarget.id);
    setDeleteTarget(null);
  }

  function handleActivate(id: string) {
    switchConnection(id);
  }

  return {
    connections,
    activeConnection,
    dialogOpen,
    setDialogOpen,
    editTarget,
    setEditTarget,
    deleteTarget,
    setDeleteTarget,
    handleAdd,
    handleEdit,
    handleSubmit,
    handleDelete,
    handleActivate,
  };
}
