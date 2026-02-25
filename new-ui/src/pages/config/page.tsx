import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useConfig } from "@/hooks/use-config";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, CheckCircle2, XCircle, Hexagon } from "lucide-react";

export default function ConfigPage() {
  const { config, setConfig, resetConfig, isConfigured } = useConfig();
  const navigate = useNavigate();

  const [apiUrl, setApiUrl] = useState(config.apiUrl);
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

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

      setConfig({ apiUrl: url, apiKey });
      setStatus("success");

      // Navigate to dashboard after brief delay
      setTimeout(() => navigate("/"), 500);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Connection failed");
    }
  }

  function handleDisconnect() {
    resetConfig();
    setApiUrl("http://localhost:3013");
    setApiKey("");
    setStatus("idle");
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center">
      <Card className="w-full max-w-md border-amber-500/20">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center">
            <Hexagon className="h-10 w-10 text-amber-500" />
          </div>
          <CardTitle className="font-display text-xl">Agent Swarm</CardTitle>
          <CardDescription>
            Connect to your Agent Swarm API server to get started.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="api-url">API URL</Label>
            <Input
              id="api-url"
              type="url"
              placeholder="http://localhost:3013"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              disabled={status === "loading"}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="api-key">API Key</Label>
            <Input
              id="api-key"
              type="password"
              placeholder="Enter your API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={status === "loading"}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConnect();
              }}
            />
          </div>

          {status === "error" && (
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertDescription>{errorMsg}</AlertDescription>
            </Alert>
          )}

          {status === "success" && (
            <Alert className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>Connected! Redirecting to dashboard...</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleConnect}
              disabled={status === "loading" || !apiUrl}
              className="flex-1 bg-amber-600 text-white hover:bg-amber-700"
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
            {isConfigured && (
              <Button variant="outline" onClick={handleDisconnect}>
                Disconnect
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
