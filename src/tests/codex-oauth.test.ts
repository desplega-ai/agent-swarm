import { afterEach, describe, expect, it } from "bun:test";
import {
  authJsonToCredentialSelection,
  authJsonToCredentials,
  credentialsToAuthJson,
} from "../providers/codex-oauth/auth-json.js";
import {
  AUTHORIZE_URL,
  CLIENT_ID,
  createAuthorizationFlow,
  createState,
  decodeJwt,
  exchangeAuthorizationCode,
  getAccountId,
  JWT_CLAIM_PATH,
  parseAuthorizationInput,
  REDIRECT_URI,
  refreshAccessToken,
  resetFetchForTesting,
  SCOPE,
  setFetchForTesting,
  TOKEN_URL,
} from "../providers/codex-oauth/flow.js";
import { generatePKCE } from "../providers/codex-oauth/pkce.js";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types.js";

describe("generatePKCE", () => {
  it("produces distinct verifier/challenge pairs", async () => {
    const a = await generatePKCE();
    const b = await generatePKCE();
    expect(a.verifier).not.toEqual(b.verifier);
    expect(a.challenge).not.toEqual(b.challenge);
  });

  it("verifier is base64url (43 chars, URL-safe)", async () => {
    const { verifier } = await generatePKCE();
    expect(verifier.length).toBe(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("challenge is base64url (43 chars, URL-safe)", async () => {
    const { challenge } = await generatePKCE();
    expect(challenge.length).toBe(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("OAuth constants", () => {
  it("has the correct public client ID", () => {
    expect(CLIENT_ID).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  });

  it("has the correct OAuth URLs", () => {
    expect(AUTHORIZE_URL).toBe("https://auth.openai.com/oauth/authorize");
    expect(TOKEN_URL).toBe("https://auth.openai.com/oauth/token");
    expect(REDIRECT_URI).toBe("http://localhost:1455/auth/callback");
  });

  it("has the correct scope", () => {
    expect(SCOPE).toBe("openid profile email offline_access");
  });

  it("has the correct JWT claim path", () => {
    expect(JWT_CLAIM_PATH).toBe("https://api.openai.com/auth");
  });
});

describe("createState", () => {
  it("produces a 32-char hex string", () => {
    const state = createState();
    expect(state.length).toBe(32);
    expect(state).toMatch(/^[0-9a-f]+$/);
  });

  it("produces different values each call", () => {
    expect(createState()).not.toEqual(createState());
  });
});

describe("parseAuthorizationInput", () => {
  it("parses bare code", () => {
    expect(parseAuthorizationInput("abc123")).toEqual({ code: "abc123" });
  });

  it("parses code=X&state=Y", () => {
    expect(parseAuthorizationInput("code=abc&state=def")).toEqual({
      code: "abc",
      state: "def",
    });
  });

  it("parses full redirect URL", () => {
    expect(
      parseAuthorizationInput("http://localhost:1455/auth/callback?code=abc&state=def"),
    ).toEqual({ code: "abc", state: "def" });
  });

  it("parses code#state format", () => {
    expect(parseAuthorizationInput("abc123#def456")).toEqual({
      code: "abc123",
      state: "def456",
    });
  });

  it("returns empty for empty string", () => {
    expect(parseAuthorizationInput("")).toEqual({});
  });

  it("returns empty for whitespace", () => {
    expect(parseAuthorizationInput("   ")).toEqual({});
  });
});

describe("decodeJwt", () => {
  it("extracts chatgpt_account_id from a JWT", () => {
    const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "acc-123" } };
    const encoded = btoa(JSON.stringify(payload));
    const token = `header.${encoded}.signature`;
    const decoded = decodeJwt(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.["https://api.openai.com/auth"]?.chatgpt_account_id).toBe("acc-123");
  });

  it("returns null for invalid JWT", () => {
    expect(decodeJwt("not-a-jwt")).toBeNull();
    expect(decodeJwt("a.b")).toBeNull();
  });
});

describe("getAccountId", () => {
  it("extracts account ID from access token", () => {
    const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "c724a178-abc" } };
    const encoded = btoa(JSON.stringify(payload));
    const token = `header.${encoded}.signature`;
    expect(getAccountId(token)).toBe("c724a178-abc");
  });

  it("returns null for JWT without claim", () => {
    const payload = { sub: "user123" };
    const encoded = btoa(JSON.stringify(payload));
    const token = `header.${encoded}.signature`;
    expect(getAccountId(token)).toBeNull();
  });

  it("returns null for empty string claim", () => {
    const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "" } };
    const encoded = btoa(JSON.stringify(payload));
    const token = `header.${encoded}.signature`;
    expect(getAccountId(token)).toBeNull();
  });
});

describe("exchangeAuthorizationCode", () => {
  afterEach(() => {
    resetFetchForTesting();
  });

  it("constructs expected POST body", async () => {
    let capturedBody: URLSearchParams | null = null;
    setFetchForTesting(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as URLSearchParams;
      return new Response(
        JSON.stringify({
          access_token: "at_123",
          refresh_token: "rt_456",
          expires_in: 3600,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await exchangeAuthorizationCode("code-abc", "verifier-xyz");
    expect(result.type).toBe("success");
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.get("grant_type")).toBe("authorization_code");
    expect(capturedBody!.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(capturedBody!.get("code")).toBe("code-abc");
    expect(capturedBody!.get("code_verifier")).toBe("verifier-xyz");
  });

  it("returns failed on HTTP error", async () => {
    setFetchForTesting(() => new Response("Bad Request", { status: 400 }));
    const result = await exchangeAuthorizationCode("code-abc", "verifier-xyz");
    expect(result.type).toBe("failed");
  });

  it("returns failed on missing fields", async () => {
    setFetchForTesting(
      () =>
        new Response(JSON.stringify({ access_token: "at" }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    const result = await exchangeAuthorizationCode("code-abc", "verifier-xyz");
    expect(result.type).toBe("failed");
  });
});

describe("refreshAccessToken", () => {
  afterEach(() => {
    resetFetchForTesting();
  });

  it("calls token endpoint with grant_type=refresh_token", async () => {
    let capturedBody: URLSearchParams | null = null;
    setFetchForTesting(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as URLSearchParams;
      return new Response(
        JSON.stringify({
          access_token: "at_new",
          refresh_token: "rt_new",
          expires_in: 3600,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await refreshAccessToken("rt_old");
    expect(result.type).toBe("success");
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.get("grant_type")).toBe("refresh_token");
    expect(capturedBody!.get("refresh_token")).toBe("rt_old");
    expect(capturedBody!.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  });

  it("returns failed on HTTP error", async () => {
    setFetchForTesting(() => new Response("Unauthorized", { status: 401 }));
    const result = await refreshAccessToken("rt_old");
    expect(result.type).toBe("failed");
  });
});

describe("createAuthorizationFlow", () => {
  it("includes required query parameters", async () => {
    const { verifier, state, url } = await createAuthorizationFlow("agent-swarm");
    expect(verifier).toBeTruthy();
    expect(state).toBeTruthy();
    expect(url).toContain(AUTHORIZE_URL);
    expect(url).toContain("response_type=code");
    expect(url).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("id_token_add_organizations=true");
    expect(url).toContain("codex_cli_simplified_flow=true");
    expect(url).toContain("originator=agent-swarm");
  });
});

describe("credentialsToAuthJson", () => {
  it("produces exact format matching observed ~/.codex/auth.json", () => {
    const creds: CodexOAuthCredentials = {
      access: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
      refresh: "rt_abc123",
      expires: 1712678400000,
      accountId: "c724a178-abc",
    };

    const authJson = credentialsToAuthJson(creds);
    expect(authJson.auth_mode).toBe("chatgpt");
    expect(authJson.OPENAI_API_KEY).toBeNull();
    expect(authJson.tokens.access_token).toBe(creds.access);
    expect(authJson.tokens.refresh_token).toBe(creds.refresh);
    expect(authJson.tokens.account_id).toBe(creds.accountId);
    expect(authJson.tokens.id_token).toBe(creds.access);
    expect(authJson.last_refresh).toBe(new Date(creds.expires).toISOString());
  });
});

describe("authJsonToCredentials", () => {
  it("round-trips correctly", () => {
    const creds: CodexOAuthCredentials = {
      access: "at_123",
      refresh: "rt_456",
      expires: Date.now() + 3600000,
      accountId: "acc-789",
    };
    const authJson = credentialsToAuthJson(creds);
    const restored = authJsonToCredentials(authJson);
    expect(restored.access).toBe(creds.access);
    expect(restored.refresh).toBe(creds.refresh);
    expect(restored.accountId).toBe(creds.accountId);
    expect(Math.abs(restored.expires - creds.expires)).toBeLessThan(1000);
  });
});

describe("authJsonToCredentialSelection", () => {
  it("maps chatgpt auth.json to CODEX_OAUTH tracking info", () => {
    const creds: CodexOAuthCredentials = {
      access: "at_123",
      refresh: "rt_456",
      expires: Date.now() + 3600000,
      accountId: "c724a178-3621-41bb-bdb5-7b6ca848c965",
    };

    const selection = authJsonToCredentialSelection(credentialsToAuthJson(creds));
    expect(selection.keyType).toBe("CODEX_OAUTH");
    expect(selection.index).toBe(0);
    expect(selection.total).toBe(1);
    expect(selection.keySuffix).toBe("8c965");
    expect(selection.selected).toBe(creds.accountId);
  });
});

describe("no secrets in source", () => {
  it("CLIENT_ID is the public OpenAI client id", () => {
    expect(CLIENT_ID).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  });
});
