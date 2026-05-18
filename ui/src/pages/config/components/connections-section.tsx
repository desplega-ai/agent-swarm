import { Plus } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { useConnections } from "@/hooks/use-connections";
import { ConnectionCard } from "./connection-card";
import { ConnectionFormDialog } from "./connection-form-dialog";

export function ConnectionsSection() {
  const {
    connections,
    activeConnection,
    dialogOpen,
    setDialogOpen,
    editTarget,
    deleteTarget,
    setDeleteTarget,
    handleAdd,
    handleEdit,
    handleSubmit,
    handleDelete,
    handleActivate,
  } = useConnections();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Connections</h2>
        <Button onClick={handleAdd} size="sm" className="gap-1 bg-primary hover:bg-primary/90">
          <Plus className="h-3.5 w-3.5" /> Add Connection
        </Button>
      </div>

      <div className="space-y-3">
        {connections.map((conn) => (
          <ConnectionCard
            key={conn.id}
            connection={conn}
            isActive={activeConnection?.id === conn.id}
            onActivate={() => handleActivate(conn.id)}
            onEdit={() => handleEdit(conn)}
            onDelete={() => setDeleteTarget(conn)}
          />
        ))}
      </div>

      <ConnectionFormDialog
        key={editTarget?.id ?? "new"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editConnection={editTarget}
        onSubmit={handleSubmit}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Connection</AlertDialogTitle>
            <AlertDialogDescription>
              {connections.length === 1 ? (
                <>
                  This is your only connection. Deleting it will clear all settings and return you
                  to the setup screen.
                </>
              ) : (
                <>
                  Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This action
                  cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
