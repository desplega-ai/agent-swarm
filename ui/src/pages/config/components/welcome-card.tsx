import { Check, CheckCircle2, Copy, Eye, EyeOff, Hexagon, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfig } from "@/hooks/use-config";
import { generateSlug } from "@/lib/slugs";

function resolvePostConnectRedirect(from: unknown): string {
  if (typeof from !== "string") return "/";
  if (!from.startsWith("/")) return "/";
  if (from === "/config" || from.startsWith("/config?") || from.startsWith("/config#")) return "/";
  return from;
}

export function WelcomeCard() {
  const { addConnection, switchConnection } = useConfig();
  const navigate = useNavigate();
  const location = useLocation();

  const [name, setName] = useState("");
  const [apiUrl, setApiUrl] = useState("http://localhost:3013");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [placeholder] = useState(() => generateSlug());

  function handleCopyApiKey() {
    navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleConnect() {
    setStatus("loading");
    setErrorMsg("");

    try {
      const url = apiUrl.replace(/\/+$/, "");
      const res = await fetch(`${url}/health`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
      await res.json();

      const created = addConnection({
        name: name || placeholder,
        apiUrl: url,
        apiKey,
      });
      switchConnection(created.id);
      setStatus("success");

      const target = resolvePostConnectRedirect((location.state as { from?: string } | null)?.from);
      setTimeout(() => navigate(target, { replace: true }), 500);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Connection failed");
    }
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center">
      <Card className="w-full max-w-md border-border">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center">
            <Hexagon className="h-10 w-10 text-primary" />
          </div>
          <CardTitle className="text-xl font-semibold">Agent Swarm</CardTitle>
          <CardDescription>Connect to your Agent Swarm API server to get started.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="welcome-name">Connection Name (optional)</Label>
            <Input
              id="welcome-name"
              placeholder={placeholder}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="welcome-url">API URL</Label>
            <Input
              id="welcome-url"
              type="url"
              placeholder="http://localhost:3013"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              disabled={status === "loading"}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="welcome-key">API Key</Label>
            <div className="flex gap-1">
              <Input
                id="welcome-key"
                type={showApiKey ? "text" : "password"}
                placeholder="Enter your API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={status === "loading"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleConnect();
                }}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={handleCopyApiKey}
                disabled={!apiKey}
              >
                {copied ? (
                  <Check className="h-4 w-4 text-status-success" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          {status === "error" && (
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertDescription>{errorMsg}</AlertDescription>
            </Alert>
          )}

          {status === "success" && (
            <Alert className="border-status-success/30 bg-status-success/10 text-status-success">
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>Connected! Redirecting to dashboard...</AlertDescription>
            </Alert>
          )}

          <Button
            onClick={handleConnect}
            disabled={status === "loading" || !apiUrl || !apiKey}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {status === "loading" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Connecting...
              </>
            ) : (
              "Connect"
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
