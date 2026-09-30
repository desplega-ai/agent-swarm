import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Info } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "@/api/client";
import { invalidateStatusQuery } from "@/api/hooks/status-query";
import { SecretInput } from "@/components/shared/secret-input";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { useCurrentUser } from "@/contexts/current-user-context";
import { AgentFsClient } from "@/lib/agent-fs/client";
import {
  type ConnectFlowDeps,
  type ConnectOutcome,
  connectWithKey,
  createAndConnect,
} from "./connect-flow";

type ConnectTab = "create" | "paste";

/**
 * Connect this browser to agent-fs as the human (not the swarm): create an
 * agent-fs identity with an email, or paste an existing `af_` key. The key is
 * verified, the identity is invited to the swarm drive when it has no access
 * yet, and only then is it saved (in this browser only).
 */
export function ConnectCard() {
  const { state, endpoint, orgId, driveId, connect } = useAgentFs();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  // A rejected saved key means the account exists: start on the paste tab.
  const [tab, setTab] = useState<ConnectTab>(state === "invalid-key" ? "paste" : "create");
  const [email, setEmail] = useState(user?.email ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Prefill the email once the current user loads. Never replace typed text.
  const userEmail = user?.email;
  useEffect(() => {
    if (userEmail) setEmail((current) => current || userEmail);
  }, [userEmail]);

  if (!endpoint) return null;
  const driveReady = orgId !== null && driveId !== null;

  const deps: ConnectFlowDeps = {
    register: (address) => AgentFsClient.register({ endpoint, email: address }),
    getMe: (key) => new AgentFsClient({ endpoint, apiKey: key }).getMe(),
    ls: (key) =>
      new AgentFsClient({ endpoint, apiKey: key }).callOp(
        orgId as string,
        "ls",
        { path: "/" },
        driveId as string,
      ),
    invite: async (address) => {
      await api.inviteAgentFsMember({ email: address, role: "editor" });
      void invalidateStatusQuery(queryClient);
    },
    connect,
  };

  async function run(action: () => Promise<ConnectOutcome>) {
    setBusy(true);
    setError(null);
    const outcome = await action();
    setBusy(false);
    if (outcome.kind === "email-taken") {
      setTab("paste");
      setNotice("This email already has an agent-fs account. Paste its key.");
    } else if (outcome.kind === "failed") {
      if (outcome.newKey) {
        // Keep the new key in the paste field, so the person can copy it and
        // connect after an admin invites them.
        setApiKey(outcome.newKey);
        setTab("paste");
        setNotice(
          "Your new agent-fs key is in the field below. Copy it before you leave this page.",
        );
      }
      setError(outcome.message);
    }
  }

  function onCreate(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!address || !driveReady) return;
    void run(() => createAndConnect(deps, address));
  }

  function onPaste(event: FormEvent) {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key || !driveReady) return;
    void run(() => connectWithKey(deps, key));
  }

  function onTabChange(next: string) {
    setTab(next as ConnectTab);
    setError(null);
    setNotice(null);
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Connect agent-fs</CardTitle>
        <CardDescription>
          Comb reads the swarm drive with your own agent-fs identity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state === "invalid-key" && (
          <AlertCallout tone="warning" icon={AlertCircle}>
            agent-fs no longer accepts your saved key. Connect again.
          </AlertCallout>
        )}
        {!driveReady && (
          <AlertCallout tone="warning" icon={AlertCircle}>
            The swarm drive is not set up yet. Ask a swarm admin to check the agent-fs setup.
          </AlertCallout>
        )}
        <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList className="w-full">
            <TabsTrigger value="create">Create with my email</TabsTrigger>
            <TabsTrigger value="paste">Paste a key</TabsTrigger>
          </TabsList>
          <TabsContent value="create">
            <form className="space-y-4 pt-2" onSubmit={onCreate}>
              <SettingsRow label="Email" htmlFor="comb-connect-email">
                <Input
                  id="comb-connect-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                  required
                />
              </SettingsRow>
              <Button
                type="submit"
                className="w-full"
                status={busy ? "loading" : "idle"}
                disabled={!driveReady}
              >
                Create and connect
              </Button>
            </form>
          </TabsContent>
          <TabsContent value="paste">
            <form className="space-y-4 pt-2" onSubmit={onPaste}>
              {notice && (
                <AlertCallout tone="info" icon={Info}>
                  {notice}
                </AlertCallout>
              )}
              <SettingsRow label="agent-fs key" htmlFor="comb-connect-key">
                <SecretInput
                  id="comb-connect-key"
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder="af_..."
                  autoComplete="new-password"
                  disabled={busy}
                  required
                />
              </SettingsRow>
              <Button
                type="submit"
                className="w-full"
                status={busy ? "loading" : "idle"}
                disabled={!driveReady}
              >
                Connect
              </Button>
            </form>
          </TabsContent>
        </Tabs>
        {error && (
          <AlertCallout tone="error" icon={AlertCircle}>
            {error}
          </AlertCallout>
        )}
        <p className="text-xs text-muted-foreground">
          Your agent-fs key is stored in this browser only. Disconnect removes it.
        </p>
      </CardContent>
    </Card>
  );
}
