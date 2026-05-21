import { X } from "lucide-react";
import type { UserIdentity } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomKindWarning, IdentityKindPicker, isPresetKind } from "./identity-kind-picker";
import { getIntegrationLabel, IntegrationIcon } from "./integration-icons";

/**
 * Pending-identity row — used by the new-user dialog while assembling a list
 * of identities to attach to the user being created. Mirrors the visual
 * density of the IdentitiesTable on the detail page (Group A): brand icon +
 * kind label on the left, external-id input in the middle, remove button on
 * the right.
 *
 * Distinct from the row on the detail-page IdentitiesTable (which is a
 * read-only persisted identity) — this one is editable until the parent
 * commits the new user.
 */
export function PendingIdentityRow({
  identity,
  onChange,
  onRemove,
}: {
  identity: UserIdentity;
  onChange: (next: UserIdentity) => void;
  onRemove: () => void;
}) {
  const customKind = !isPresetKind(identity.kind) && identity.kind !== "";
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5">
        <div className="flex items-center gap-1.5 min-w-[110px] pl-0.5">
          <IntegrationIcon kind={identity.kind} className="h-4 w-4 text-foreground/80" />
          <span className="text-xs font-medium">{getIntegrationLabel(identity.kind)}</span>
        </div>
        <Input
          value={identity.externalId}
          onChange={(e) => onChange({ ...identity, externalId: e.target.value })}
          placeholder={placeholderFor(identity.kind)}
          className="h-7 font-mono text-xs"
          aria-label={`External ID for ${getIntegrationLabel(identity.kind)}`}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onRemove}
          className="h-7 w-7 text-muted-foreground hover:text-status-error-strong"
          aria-label="Remove identity"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {customKind && <CustomKindWarning className="pl-2" />}
    </div>
  );
}

/**
 * Header used above pending-identity rows; renders the kind picker for the
 * draft row.
 */
export function PendingIdentityComposer({
  draftKind,
  setDraftKind,
  draftId,
  setDraftId,
  onAdd,
}: {
  draftKind: string;
  setDraftKind: (next: string) => void;
  draftId: string;
  setDraftId: (next: string) => void;
  onAdd: () => void;
}) {
  const customKind = !isPresetKind(draftKind) && draftKind !== "";
  return (
    <div className="space-y-2 rounded-md border border-dashed border-border bg-muted/20 p-2.5">
      <IdentityKindPicker value={draftKind} onChange={setDraftKind} />
      <div className="grid grid-cols-[1fr_auto] items-center gap-2">
        <Input
          value={draftId}
          onChange={(e) => setDraftId(e.target.value)}
          placeholder={placeholderFor(draftKind)}
          className="h-8 font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onAdd}
          disabled={!draftId.trim() || !draftKind.trim()}
        >
          Add identity
        </Button>
      </div>
      {customKind && <CustomKindWarning />}
    </div>
  );
}

function placeholderFor(kind: string): string {
  switch (kind) {
    case "slack":
      return "U12345…";
    case "github":
      return "123456 (numeric ID)";
    case "linear":
      return "uuid";
    case "gitlab":
      return "123";
    default:
      return "external id";
  }
}
