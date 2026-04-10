/**
 * OpenAI Codex (ChatGPT OAuth) flow.
 *
 * Ported from pi-mono's `utils/oauth/openai-codex.js` with adaptations
 * for agent-swarm's types and runtime. Uses `node:http` for the loopback
 * server (compatible with both Bun and Node.js).
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { generatePKCE } from "./pkce.js";
import type { CodexOAuthCallbacks, CodexOAuthCredentials, TokenResult } from "./types.js";

/** Custom fetch for testing. Override via setFetchForTesting(). */
const _fetchHolder: { current: typeof fetch } = { current: globalThis.fetch };

/** Replace fetch for unit tests. Call resetFetchForTesting() in afterEach. */
export function setFetchForTesting(customFetch: typeof fetch): void {
  _fetchHolder.current = customFetch;
}

/** Restore original fetch after testing. */
export function resetFetchForTesting(): void {
  _fetchHolder.current = globalThis.fetch;
}

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPE = "openid profile email offline_access";
export const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authentication successful</title>
</head>
<body>
  <p>Authentication successful. Return to your terminal to continue.</p>
</body>
</html>`;

export function createState(): string {
  return randomBytes(16).toString("hex");
}

export function parseAuthorizationInput(input: string): {
  code?: string;
  state?: string;
} {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

export function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1] ?? "";
    const decoded = atob(payload);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string = REDIRECT_URI,
): Promise<TokenResult> {
  const response = await _fetchHolder.current(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("[codex-oauth] code->token failed:", response.status, text);
    return { type: "failed" };
  }

  const json = (await response.json()) as Record<string, unknown>;
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    console.error("[codex-oauth] token response missing fields:", json);
    return { type: "failed" };
  }

  return {
    type: "success",
    access: json.access_token as string,
    refresh: json.refresh_token as string,
    expires: Date.now() + (json.expires_in as number) * 1000,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  try {
    const response = await _fetchHolder.current(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("[codex-oauth] Token refresh failed:", response.status, text);
      return { type: "failed" };
    }

    const json = (await response.json()) as Record<string, unknown>;
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
      console.error("[codex-oauth] Token refresh response missing fields:", json);
      return { type: "failed" };
    }

    return {
      type: "success",
      access: json.access_token as string,
      refresh: json.refresh_token as string,
      expires: Date.now() + (json.expires_in as number) * 1000,
    };
  } catch (error) {
    console.error("[codex-oauth] Token refresh error:", error);
    return { type: "failed" };
  }
}

export function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

export async function createAuthorizationFlow(
  originator = "agent-swarm",
): Promise<{ verifier: string; state: string; url: string }> {
  const { verifier, challenge } = await generatePKCE();
  const state = createState();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return { verifier, state, url: url.toString() };
}

type LocalOAuthServer = {
  close: () => void;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
};

export function startLocalOAuthServer(state: string): Promise<LocalOAuthServer> {
  let lastCode: string | null = null;
  let cancelled = false;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.end("Missing authorization code");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
      lastCode = code;
    } catch {
      res.statusCode = 500;
      res.end("Internal error");
    }
  });

  return new Promise((resolve) => {
    server
      .listen(1455, "127.0.0.1", () => {
        resolve({
          close: () => server.close(),
          cancelWait: () => {
            cancelled = true;
          },
          waitForCode: async () => {
            const sleep = () => new Promise((r) => setTimeout(r, 100));
            for (let i = 0; i < 600; i += 1) {
              if (lastCode) return { code: lastCode };
              if (cancelled) return null;
              await sleep();
            }
            return null;
          },
        });
      })
      .on("error", (err: NodeJS.ErrnoException) => {
        console.error(
          `[codex-oauth] Failed to bind http://127.0.0.1:1455 (${err.code}). Falling back to manual paste.`,
        );
        resolve({
          close: () => {
            try {
              server.close();
            } catch {
              // ignore
            }
          },
          cancelWait: () => {},
          waitForCode: async () => null,
        });
      });
  });
}

export async function loginCodexOAuth(
  callbacks: CodexOAuthCallbacks,
): Promise<CodexOAuthCredentials> {
  const { verifier, state, url } = await createAuthorizationFlow(callbacks.originator);
  const server = await startLocalOAuthServer(state);
  callbacks.onAuth({
    url,
    instructions: "A browser window should open. Complete login to finish.",
  });

  let code: string | undefined;

  try {
    if (callbacks.onManualCodeInput) {
      let manualCode: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = callbacks
        .onManualCodeInput()
        .then((input: string) => {
          manualCode = input;
          server.cancelWait();
        })
        .catch((err: unknown) => {
          manualError = err instanceof Error ? err : new Error(String(err));
          server.cancelWait();
        });

      const result = await server.waitForCode();

      if (manualError) {
        throw manualError;
      }

      if (result?.code) {
        code = result.code;
      } else if (manualCode) {
        const parsed = parseAuthorizationInput(manualCode);
        if (parsed.state && parsed.state !== state) {
          throw new Error("State mismatch");
        }
        code = parsed.code;
      }

      if (!code) {
        await manualPromise;
        if (manualError) {
          throw manualError;
        }
        if (manualCode) {
          const parsed = parseAuthorizationInput(manualCode);
          if (parsed.state && parsed.state !== state) {
            throw new Error("State mismatch");
          }
          code = parsed.code;
        }
      }
    } else {
      const result = await server.waitForCode();
      if (result?.code) {
        code = result.code;
      }
    }

    if (!code) {
      const input = await callbacks.onPrompt({
        message: "Paste the authorization code (or full redirect URL):",
      });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error("State mismatch");
      }
      code = parsed.code;
    }

    if (!code) {
      throw new Error("Missing authorization code");
    }

    const tokenResult = await exchangeAuthorizationCode(code, verifier);
    if (tokenResult.type !== "success") {
      throw new Error("Token exchange failed");
    }

    const accountId = getAccountId(tokenResult.access);
    if (!accountId) {
      throw new Error("Failed to extract accountId from token");
    }

    return {
      access: tokenResult.access,
      refresh: tokenResult.refresh,
      expires: tokenResult.expires,
      accountId,
    };
  } finally {
    server.close();
  }
}
