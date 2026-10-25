import { toast } from "sonner";
import { useCodexAccounts, useRemoveCodexAccount } from "@/api/hooks/use-codex-accounts";
import type { CodexAccount } from "@/api/types";
import { KeyStatusPill, type KeyStatusTone } from "@/components/shared/key-status-pill";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const ACCOUNT_STATE: Record<CodexAccount["status"], { tone: KeyStatusTone; pill: string }> = {
  ok: { tone: "success", pill: "Signed in" },
  needs_login: { tone: "error", pill: "Sign in again" },
  unchecked: { tone: "neutral", pill: "Not checked yet" },
};

/** "ChatGPT account ending abcde", or the slot when the stored token has no readable suffix. */
function accountName(account: CodexAccount): string {
  return account.suffix
    ? `ChatGPT account ending ${account.suffix}`
    : `ChatGPT account (slot ${account.slot})`;
}

export interface CodexAccountsListProps {
  /** After a remove: the accounts that are left. */
  onRemoved?: (accounts: CodexAccount[]) => void;
}

/**
 * The stored ChatGPT accounts (`codex_oauth_<n>` slots), one row each: the
 * token suffix, the plan and the email when known, the status, and Remove.
 */
export function CodexAccountsList({ onRemoved }: CodexAccountsListProps) {
  const { data: accounts, error } = useCodexAccounts();
  const remove = useRemoveCodexAccount();
  const removingSlot = remove.isPending ? remove.variables : undefined;

  if (!accounts) {
    return error ? (
      <p className="text-xs text-status-error-strong">{error.message}</p>
    ) : (
      <Skeleton className="h-11 w-full" />
    );
  }
  if (accounts.length === 0) {
    return <p className="text-xs text-muted-foreground">No ChatGPT accounts yet.</p>;
  }

  function removeAccount(slot: number) {
    remove.mutate(slot, {
      onSuccess: (response) => onRemoved?.(response.accounts),
      onError: (err) => toast.error(err.message),
    });
  }

  return (
    <ul
      aria-label="ChatGPT accounts"
      className="divide-y divide-border-subtle rounded-md border border-border"
    >
      {accounts.map((account) => (
        <CodexAccountRow
          key={account.configKey}
          account={account}
          removing={removingSlot === account.slot}
          disabled={remove.isPending}
          onRemove={() => removeAccount(account.slot)}
        />
      ))}
    </ul>
  );
}

function CodexAccountRow({
  account,
  removing,
  disabled,
  onRemove,
}: {
  account: CodexAccount;
  removing: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  const state = ACCOUNT_STATE[account.status] ?? ACCOUNT_STATE.unchecked;
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm">
            {account.suffix ? (
              <>
                ChatGPT account ending <span className="font-mono">{account.suffix}</span>
              </>
            ) : (
              `ChatGPT account (slot ${account.slot})`
            )}
          </span>
          {account.plan ? (
            <Badge variant="outline" size="tag" className="text-muted-foreground">
              {account.plan}
            </Badge>
          ) : null}
          <KeyStatusPill tone={state.tone}>{state.pill}</KeyStatusPill>
        </div>
        {account.email ? (
          <p className="text-xs break-all text-muted-foreground">{account.email}</p>
        ) : null}
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="destructive-outline"
            size="sm"
            className="shrink-0"
            disabled={disabled}
            aria-label={`${removing ? "Removing" : "Remove"} ${accountName(account)}`}
          >
            {removing ? "Removing…" : "Remove"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this ChatGPT account?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents stop using it within about 10 seconds. You can sign in again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onRemove}>
              Remove account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
