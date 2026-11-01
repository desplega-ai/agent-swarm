import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  callTool,
  cleanupStack,
  expectToolError,
  expectToolOk,
  jsonResponse,
  type MockRequest,
  registerAgent,
  startMockServer,
} from "./platform-helpers";

// Generic OAuth apps for script credential bindings, run against a loopback provider that
// plays the authorization server: discovery, code exchange, refresh and revocation. The
// swarm talks to it exactly as it would to Google or Slack, so the whole app ->
// authorize-url -> callback -> authorization -> refresh -> disconnect -> delete journey is
// real except for the provider.

type Provider = ReturnType<typeof startProvider>;

function startProvider() {
  let issued = 0;
  const state = { failRefresh: false };
  const server = startMockServer((request: MockRequest) => {
    if (request.path === "/.well-known/oauth-authorization-server") {
      return jsonResponse({
        issuer: server.origin,
        authorization_endpoint: `${server.origin}/authorize`,
        token_endpoint: `${server.origin}/token`,
        scopes_supported: ["read", "write"],
      });
    }
    if (request.path === "/token") {
      const grant = request.form.get("grant_type");
      if (grant === "authorization_code") {
        const code = request.form.get("code");
        if (code === "bad") return jsonResponse({ error: "invalid_grant" }, 400);
        issued += 1;
        return jsonResponse({
          access_token: `at-${issued}`,
          ...(code === "norefresh" ? {} : { refresh_token: `rt-${issued}` }),
          expires_in: code === "short" ? 120 : 3600,
          token_type: "Bearer",
          scope: "read write",
        });
      }
      if (grant === "refresh_token") {
        if (state.failRefresh) return jsonResponse({ error: "invalid_grant" }, 400);
        issued += 1;
        return jsonResponse({
          access_token: `at-${issued}`,
          refresh_token: `rt-${issued}`,
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      return jsonResponse({ error: "unsupported_grant_type" }, 400);
    }
    if (request.path === "/revoke") return jsonResponse({});
    return new Response("not found", { status: 404 });
  });
  return Object.assign(server, { state });
}

function tokenRequests(provider: Provider, grant: string): MockRequest[] {
  return provider.requests.filter((r) => r.path === "/token" && r.form.get("grant_type") === grant);
}

/** POST authorize-url and return its state and parsed URL. */
async function authorize(
  ctx: ScenarioContext,
  appId: string,
  body: Record<string, unknown> | undefined,
) {
  const response = await ctx.api("POST", `/api/oauth-apps/${appId}/authorize-url`, { body });
  expectStatus(response, [200], "build authorize url");
  const result = asRecord(response.json);
  return {
    state: String(result.state),
    label: String(result.label),
    redirectUri: String(result.redirectUri),
    url: new URL(String(result.authorizeUrl)),
  };
}

export const platformOauthApps: Scenario = {
  name: "platform-oauth-apps",
  order: 630,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const provider = startProvider();
    cleanup.add("stop the oauth provider", async () => provider.stop());
    const providerSlug = `e2eoauth${ctx.nonce}`;
    const clientSecret = `client-secret-${ctx.nonce}`;
    const finalRedirect = "https://app.example.com/oauth-done";
    try {
      // ── auth ───────────────────────────────────────────────────────────────
      for (const [method, path] of [
        ["GET", "/api/oauth-apps"],
        ["GET", "/api/oauth-presets"],
        ["GET", "/api/oauth/redirect-uri"],
        ["POST", "/api/oauth-apps"],
        ["DELETE", "/api/oauth-apps/whatever"],
      ] as const) {
        expectStatus(
          await ctx.api(method, path, { apiKey: null, body: method === "POST" ? {} : undefined }),
          [401],
          `${method} ${path} unauth`,
        );
      }

      // ── redirect uri and presets ───────────────────────────────────────────
      const redirect = await ctx.api("GET", "/api/oauth/redirect-uri");
      expectStatus(redirect, [200], "redirect uri");
      const redirectUri = String(asRecord(redirect.json).redirectUri);
      expect(
        redirectUri.endsWith("/api/oauth/callback"),
        `the static callback is /api/oauth/callback, got ${redirectUri}`,
      );

      const presetsResponse = await ctx.api("GET", "/api/oauth-presets");
      expectStatus(presetsResponse, [200], "list presets");
      const presets = asRecords(presetsResponse.json, "presets");
      expect(presets.length > 0, "the preset catalog is not empty");
      const google = presets.find((p) => p.id === "google");
      expect(
        google &&
          typeof google.authorizeUrl === "string" &&
          typeof google.tokenUrl === "string" &&
          Array.isArray(google.scopes) &&
          Array.isArray(google.setupHints),
        "a preset carries endpoints, scopes and setup hints",
      );
      expect(
        !JSON.stringify(presets).toLowerCase().includes("clientsecret"),
        "presets never carry credentials",
      );

      // ── discovery ──────────────────────────────────────────────────────────
      const discovered = await ctx.api("POST", "/api/oauth-apps/discover", {
        body: { url: provider.origin },
      });
      expectStatus(discovered, [200], "discover provider metadata");
      const meta = asRecord(discovered.json);
      expect(
        meta.authorizeUrl === `${provider.origin}/authorize` &&
          meta.tokenUrl === `${provider.origin}/token` &&
          meta.sourceUrl === `${provider.origin}/.well-known/oauth-authorization-server` &&
          (meta.scopes as string[]).join() === "read,write",
        `discovery reads the well-known document: ${JSON.stringify(meta)}`,
      );
      expectStatus(
        await ctx.api("POST", "/api/oauth-apps/discover", {
          body: { url: `${provider.origin}/nothing-here` },
        }),
        [400],
        "discover a host without metadata",
      );
      expectStatus(
        await ctx.api("POST", "/api/oauth-apps/discover", { body: { url: "ftp://example.com" } }),
        [400],
        "discover a non-http url",
      );
      expectStatus(
        await ctx.api("POST", "/api/oauth-apps/discover", { body: { url: "not a url" } }),
        [400],
        "discover an invalid url",
      );

      // ── create and validate apps ───────────────────────────────────────────
      const body = {
        provider: providerSlug,
        clientId: `client-${ctx.nonce}`,
        clientSecret,
        authorizeUrl: `${provider.origin}/authorize`,
        tokenUrl: `${provider.origin}/token`,
        revocationUrl: `${provider.origin}/revoke`,
        scopes: ["read", "write"],
      };
      const created = await ctx.api("POST", "/api/oauth-apps", { body });
      expectStatus(created, [200], "create an oauth app");
      cleanup.add("delete the oauth app", async () => {
        await ctx.api("DELETE", `/api/oauth-apps/${providerSlug}`);
      });
      const createdBody = asRecord(created.json);
      const app = asRecord(createdBody.oauthApp);
      const appId = String(app.id);
      expect(
        createdBody.redirectUri === redirectUri,
        "create returns the callback uri to register",
      );
      expect(
        app.provider === providerSlug &&
          app.clientId === body.clientId &&
          app.authorizeUrl === body.authorizeUrl &&
          app.tokenUrl === body.tokenUrl &&
          app.redirectUri === redirectUri &&
          (app.scopes as string[]).join() === "read,write" &&
          app.tokenAuthStyle === "body" &&
          app.tokenBodyFormat === "form" &&
          app.tokenStatus === "missing" &&
          (app.authorizations as unknown[]).length === 0,
        `the app has defaults and no tokens yet: ${JSON.stringify(app)}`,
      );
      expect(!created.text.includes(clientSecret), "the client secret never leaves the server");
      const stored = ctx.db.get<{ clientSecret: string }>(
        "SELECT clientSecret FROM oauth_apps WHERE id = ?",
        [appId],
      );
      expect(
        stored && stored.clientSecret !== clientSecret,
        "the client secret is stored encrypted",
      );

      const listed = await ctx.api("GET", "/api/oauth-apps");
      expectStatus(listed, [200], "list oauth apps");
      expect(
        asRecords(listed.json, "oauthApps").some((a) => a.id === appId),
        "the app is listed",
      );
      expect(!listed.text.includes(clientSecret), "the list never carries client secrets");

      expectStatus(
        await ctx.api("POST", "/api/oauth-apps", {
          body: { ...body, provider: `${providerSlug}x`, clientSecret: undefined },
        }),
        [400],
        "create without a client secret",
      );
      expectStatus(
        await ctx.api("POST", "/api/oauth-apps", { body: { clientId: "x", clientSecret: "y" } }),
        [400],
        "create without provider or endpoints",
      );
      expectStatus(
        await ctx.api("POST", "/api/oauth-apps", {
          body: { ...body, provider: `${providerSlug}y`, presetId: "no-such-preset" },
        }),
        [400],
        "create with an unknown preset",
      );
      expectStatus(
        await ctx.api("POST", "/api/oauth-apps", {
          body: { ...body, provider: `${providerSlug}z`, authorizeUrl: "file:///etc/passwd" },
        }),
        [400],
        "create with a non-http authorize url",
      );
      expectStatus(
        await ctx.api("POST", "/api/oauth-apps", { body: { ...body, provider: "bad provider!" } }),
        [400],
        "create with an invalid provider slug",
      );

      // Editing by id keeps the stored secret when none is sent.
      const edited = await ctx.api("POST", "/api/oauth-apps", {
        body: {
          id: appId,
          provider: providerSlug,
          clientId: `client-${ctx.nonce}-v2`,
          authorizeUrl: body.authorizeUrl,
          tokenUrl: body.tokenUrl,
          scopes: ["read"],
        },
      });
      expectStatus(edited, [200], "edit an oauth app");
      expect(asRecord(asRecord(edited.json).oauthApp).id === appId, "edit updates the same app");
      expect(
        (asRecord(asRecord(edited.json).oauthApp).scopes as string[]).join() === "read",
        "edit replaces the scopes",
      );
      expectStatus(
        await ctx.api("POST", "/api/oauth-apps", { body: { ...body, id: "no-such-app" } }),
        [404],
        "edit an unknown app",
      );
      // Restore the revocation url the edit dropped, and the scopes.
      expectStatus(
        await ctx.api("POST", "/api/oauth-apps", { body: { ...body, id: appId } }),
        [200],
        "restore the app",
      );

      // A preset hydrates endpoints, scope separator, extra params and hints; fields override it.
      const presetSlug = `e2epreset${ctx.nonce}`;
      const preset = await ctx.api("POST", "/api/oauth-apps", {
        body: {
          presetId: "google",
          provider: presetSlug,
          clientId: "preset-client",
          clientSecret: "preset-secret",
          tokenUrl: body.tokenUrl,
        },
      });
      expectStatus(preset, [200], "create from a preset");
      cleanup.add("delete the preset app", async () => {
        await ctx.api("DELETE", `/api/oauth-apps/${presetSlug}`);
      });
      const presetBody = asRecord(preset.json);
      const presetApp = asRecord(presetBody.oauthApp);
      expect(
        presetApp.provider === presetSlug &&
          presetApp.authorizeUrl === google?.authorizeUrl &&
          presetApp.tokenUrl === body.tokenUrl &&
          presetApp.source === "curated-prefill" &&
          asRecord(presetApp.extraParams).access_type === "offline",
        `a preset prefills the app and explicit fields win: ${JSON.stringify(presetApp)}`,
      );
      expect(
        Array.isArray(presetBody.setupHints) && (presetBody.setupHints as unknown[]).length > 0,
        "a preset app returns its setup hints",
      );
      const presetAuth = await authorize(ctx, String(presetApp.id), undefined);
      expect(
        presetAuth.url.searchParams.get("scope") === (google?.scopes as string[]).join(" ") &&
          presetAuth.url.searchParams.get("access_type") === "offline",
        "the preset's scope separator and extra params reach the authorize url",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/oauth-apps/${presetSlug}`),
        [200],
        "delete the preset app",
      );

      // ── authorize url ──────────────────────────────────────────────────────
      expectStatus(
        await ctx.api("POST", "/api/oauth-apps/no-such-app/authorize-url", { body: {} }),
        [404],
        "authorize url for an unknown app",
      );
      expectStatus(
        await ctx.api("POST", `/api/oauth-apps/${appId}/authorize-url`, {
          body: { finalRedirect: "javascript:alert(1)" },
        }),
        [400],
        "authorize url with a non-http finalRedirect",
      );
      const work = await authorize(ctx, appId, { label: "work" });
      expect(
        work.label === "work" && work.redirectUri === redirectUri,
        "authorize-url echoes the label and callback uri",
      );
      const query = work.url.searchParams;
      expect(
        `${work.url.origin}${work.url.pathname}` === body.authorizeUrl &&
          query.get("client_id") === `client-${ctx.nonce}` &&
          query.get("redirect_uri") === redirectUri &&
          query.get("response_type") === "code" &&
          query.get("scope") === "read write" &&
          query.get("code_challenge_method") === "S256" &&
          (query.get("code_challenge") ?? "").length >= 43 &&
          query.get("state") === work.state,
        `the authorize url carries client, redirect, PKCE and state: ${work.url}`,
      );
      expect(
        !work.url.toString().includes(clientSecret),
        "the authorize url never carries the client secret",
      );
      const pending = ctx.db.get<{ appId: string; label: string; flow: string }>(
        "SELECT appId, label, flow FROM oauth_pending WHERE state = ?",
        [work.state],
      );
      expect(
        pending?.appId === appId && pending.label === "work" && pending.flow === "generic",
        "the pending state is stored for the callback",
      );
      const defaultLabel = await authorize(ctx, appId, undefined);
      expect(defaultLabel.label === "default", "the label defaults to default");
      // Consume that state below as the default authorization.

      // ── callback error paths ───────────────────────────────────────────────
      expectStatus(
        await ctx.api("GET", "/api/oauth/callback", { apiKey: null }),
        [400],
        "callback without state",
      );
      expectStatus(
        await ctx.api("GET", "/api/oauth/callback?code=x&state=unknown", { apiKey: null }),
        [400],
        "callback with an unknown state",
      );
      const denied = await authorize(ctx, appId, { label: "denied", finalRedirect });
      const deniedResponse = await ctx.api(
        "GET",
        `/api/oauth/callback?state=${denied.state}&error=access_denied&error_description=nope`,
        {
          apiKey: null,
          redirect: "manual",
        },
      );
      expectStatus(deniedResponse, [302], "callback after the user denied access");
      const deniedTarget = new URL(deniedResponse.headers.get("location") ?? "http://invalid");
      expect(
        `${deniedTarget.origin}${deniedTarget.pathname}` === finalRedirect &&
          deniedTarget.searchParams.get("oauth") === "error" &&
          deniedTarget.searchParams.get("error") === "access_denied",
        "a denied callback redirects to finalRedirect with oauth=error",
      );
      expectStatus(
        await ctx.api("GET", `/api/oauth/callback?state=${denied.state}&code=late`, {
          apiKey: null,
        }),
        [400],
        "a state is single use",
      );
      const deniedPlain = await authorize(ctx, appId, { label: "denied-plain" });
      const deniedPlainResponse = await ctx.api(
        "GET",
        `/api/oauth/callback?state=${deniedPlain.state}&error=access_denied&error_description=user%20said%20no`,
        { apiKey: null },
      );
      expectStatus(deniedPlainResponse, [400], "denied callback without finalRedirect");
      expect(
        String(asRecord(deniedPlainResponse.json).error).includes("user said no"),
        "the denial description is the error",
      );
      const noCode = await authorize(ctx, appId, { label: "nocode", finalRedirect });
      const noCodeResponse = await ctx.api("GET", `/api/oauth/callback?state=${noCode.state}`, {
        apiKey: null,
        redirect: "manual",
      });
      expectStatus(noCodeResponse, [302], "callback without a code");
      expect(
        new URL(noCodeResponse.headers.get("location") ?? "http://invalid").searchParams.get(
          "error",
        ) === "missing_code",
        "a missing code redirects with missing_code",
      );
      const badCode = await authorize(ctx, appId, { label: "badcode" });
      const badCodeResponse = await ctx.api(
        "GET",
        `/api/oauth/callback?state=${badCode.state}&code=bad`,
        { apiKey: null },
      );
      expectStatus(badCodeResponse, [502], "callback when the provider rejects the code");
      expect(
        String(asRecord(badCodeResponse.json).error).startsWith("Token exchange failed"),
        "a rejected code is a token exchange failure",
      );
      const badCodeRedirect = await authorize(ctx, appId, { label: "badcode2", finalRedirect });
      const badCodeRedirectResponse = await ctx.api(
        "GET",
        `/api/oauth/callback?state=${badCodeRedirect.state}&code=bad`,
        { apiKey: null, redirect: "manual" },
      );
      expectStatus(badCodeRedirectResponse, [302], "rejected code with finalRedirect");
      expect(
        new URL(
          badCodeRedirectResponse.headers.get("location") ?? "http://invalid",
        ).searchParams.get("oauth") === "error",
        "a rejected code redirects with oauth=error",
      );
      expect(
        asRecords(
          (await ctx.api("GET", `/api/oauth-apps/${appId}/authorizations`)).json,
          "authorizations",
        ).length === 0,
        "failed callbacks create no authorization",
      );

      // ── successful callbacks ───────────────────────────────────────────────
      const success = await ctx.api(
        "GET",
        `/api/oauth/callback?state=${defaultLabel.state}&code=code-default`,
        { apiKey: null },
      );
      expectStatus(success, [200], "callback exchanges the code");
      expect(
        success.headers.get("content-type")?.includes("text/html"),
        "the success page is html",
      );
      expect(
        success.text.includes(`${providerSlug} authorized`),
        "the success page names the provider",
      );
      const exchange = tokenRequests(provider, "authorization_code").find(
        (r) => r.form.get("code") === "code-default",
      );
      expect(exchange, "the swarm exchanged the code at the provider's token endpoint");
      expect(
        exchange.form.get("redirect_uri") === redirectUri &&
          (exchange.form.get("code_verifier") ?? "").length >= 43 &&
          exchange.form.get("client_id") === `client-${ctx.nonce}` &&
          exchange.form.get("client_secret") === clientSecret,
        "the token request carries redirect uri, PKCE verifier and client credentials",
      );
      expectStatus(
        await ctx.api("GET", `/api/oauth/callback?state=${defaultLabel.state}&code=again`, {
          apiKey: null,
        }),
        [400],
        "replaying a consumed state",
      );

      const workSuccess = await ctx.api(
        "GET",
        `/api/oauth/callback?state=${work.state}&code=code-work`,
        { apiKey: null },
      );
      expectStatus(workSuccess, [200], "callback for the work label");
      expect(workSuccess.text.includes('"work"'), "the success page names the label");
      const noRefresh = await authorize(ctx, appId, { label: "norefresh", finalRedirect });
      const noRefreshResponse = await ctx.api(
        "GET",
        `/api/oauth/callback?state=${noRefresh.state}&code=norefresh`,
        { apiKey: null, redirect: "manual" },
      );
      expectStatus(noRefreshResponse, [302], "callback with finalRedirect");
      const doneTarget = new URL(noRefreshResponse.headers.get("location") ?? "http://invalid");
      expect(
        doneTarget.searchParams.get("oauth") === "success" &&
          `${doneTarget.origin}${doneTarget.pathname}` === finalRedirect,
        "a successful callback redirects with oauth=success",
      );

      // The legacy per-provider callback delegates to the same handler.
      const legacy = await authorize(ctx, appId, { label: "legacy" });
      expectStatus(
        await ctx.api("GET", `/api/oauth/${providerSlug}/callback`, { apiKey: null }),
        [400],
        "legacy callback without state",
      );
      expectStatus(
        await ctx.api("GET", `/api/oauth/${providerSlug}/callback?state=unknown&code=x`, {
          apiKey: null,
        }),
        [400],
        "legacy callback with an unknown state",
      );
      expectStatus(
        await ctx.api("GET", "/api/oauth/bad.provider/callback?state=x&code=x", { apiKey: null }),
        [400],
        "legacy callback with an invalid provider slug",
      );
      expectStatus(
        await ctx.api(
          "GET",
          `/api/oauth/${providerSlug}/callback?state=${legacy.state}&code=code-legacy`,
          { apiKey: null },
        ),
        [200],
        "legacy callback completes a flow",
      );

      // ── authorizations ─────────────────────────────────────────────────────
      const authorizations = await ctx.api("GET", `/api/oauth-apps/${appId}/authorizations`);
      expectStatus(authorizations, [200], "list authorizations");
      const rows = asRecords(authorizations.json, "authorizations");
      const byLabel = (label: string) => rows.find((r) => r.label === label);
      expect(
        ["default", "work", "norefresh", "legacy"].every((label) => byLabel(label)),
        `all four labels are connected: ${rows.map((r) => r.label)}`,
      );
      const defaultRow = byLabel("default");
      expect(
        defaultRow?.status === "active" &&
          defaultRow.hasRefreshToken === true &&
          typeof defaultRow.expiresAt === "string" &&
          defaultRow.scope === "read write",
        `an authorization shows status, expiry and scope: ${JSON.stringify(defaultRow)}`,
      );
      expect(
        byLabel("norefresh")?.hasRefreshToken === false,
        "an authorization without a refresh token says so",
      );
      expect(!/at-\d|rt-\d/.test(authorizations.text), "the list never carries token material");
      expectStatus(
        await ctx.api("GET", "/api/oauth-apps/no-such-app/authorizations"),
        [404],
        "authorizations of an unknown app",
      );
      const withTokens = asRecords(
        (await ctx.api("GET", "/api/oauth-apps")).json,
        "oauthApps",
      ).find((a) => a.id === appId);
      expect(
        ["ok", "expiring"].includes(String(withTokens?.tokenStatus)),
        "a connected app reports a usable token status",
      );

      // ── refresh ────────────────────────────────────────────────────────────
      const refreshCallsBefore = tokenRequests(provider, "refresh_token").length;
      const refreshed = await ctx.api(
        "POST",
        `/api/oauth-authorizations/${String(defaultRow?.id)}/refresh`,
      );
      expectStatus(refreshed, [200], "refresh an authorization");
      const refreshedBody = asRecord(refreshed.json);
      expect(
        refreshedBody.ok === true &&
          refreshedBody.status === "active" &&
          typeof refreshedBody.expiresAt === "string",
        "refresh answers ok, status and expiry",
      );
      const refreshCall = tokenRequests(provider, "refresh_token")[refreshCallsBefore];
      expect(
        refreshCall && /^rt-\d+$/.test(refreshCall.form.get("refresh_token") ?? ""),
        "refresh sent the stored refresh token",
      );
      expect(!refreshed.text.includes("at-"), "refresh never returns token values");
      expectStatus(
        await ctx.api(
          "POST",
          `/api/oauth-authorizations/${String(byLabel("norefresh")?.id)}/refresh`,
        ),
        [400],
        "refresh without a stored refresh token",
      );
      expectStatus(
        await ctx.api("POST", "/api/oauth-authorizations/no-such-authorization/refresh"),
        [404],
        "refresh an unknown authorization",
      );
      provider.state.failRefresh = true;
      const failedRefresh = await ctx.api(
        "POST",
        `/api/oauth-authorizations/${String(byLabel("work")?.id)}/refresh`,
      );
      expectStatus(failedRefresh, [502], "refresh when the provider rejects it");
      expect(
        String(asRecord(failedRefresh.json).error).startsWith("Refresh failed"),
        "a rejected refresh is reported",
      );
      expectStatus(
        await ctx.api("POST", `/api/oauth-apps/${providerSlug}/refresh`),
        [502],
        "provider refresh when the provider rejects it",
      );
      provider.state.failRefresh = false;
      const providerRefresh = await ctx.api("POST", `/api/oauth-apps/${providerSlug}/refresh`);
      expectStatus(providerRefresh, [200], "refresh by provider");
      const providerRefreshBody = asRecord(providerRefresh.json);
      expect(
        providerRefreshBody.refreshed === true && typeof providerRefreshBody.expiresAt === "string",
        "provider refresh answers refreshed and expiry",
      );
      expectStatus(
        await ctx.api("POST", "/api/oauth-apps/no-such-provider/refresh"),
        [404],
        "refresh an unknown provider",
      );

      // ── the access-token tool ──────────────────────────────────────────────
      const agentId = await registerAgent(ctx, "oauth");
      const connection = await ctx.connectMcp(agentId);
      try {
        const byProvider = expectToolOk(
          await callTool(connection, "get-oauth-access-token", { provider: providerSlug }),
          "get-oauth-access-token by provider",
        );
        const issuedToken = String(byProvider.data.accessToken);
        expect(
          /^at-\d+$/.test(issuedToken) &&
            byProvider.data.tokenType === "Bearer" &&
            byProvider.data.provider === providerSlug,
          "the tool returns the provider's current access token",
        );
        expect(byProvider.text.includes(issuedToken), "the token is in the tool text");
        expect(
          !JSON.stringify(byProvider.data).includes("rt-"),
          "the tool never returns the refresh token",
        );
        const byAuthorization = expectToolOk(
          await callTool(connection, "get-oauth-access-token", {
            authorizationId: String(byLabel("work")?.id),
          }),
          "get-oauth-access-token by authorization",
        );
        expect(
          /^at-\d+$/.test(String(byAuthorization.data.accessToken)),
          "the tool resolves a labeled authorization",
        );
        expectToolError(
          await callTool(connection, "get-oauth-access-token", {}),
          "get-oauth-access-token without target",
          "provider or authorizationId",
        );
        expectToolError(
          await callTool(connection, "get-oauth-access-token", { provider: `nope${ctx.nonce}` }),
          "get-oauth-access-token unknown provider",
          "not connected",
        );
        expectToolError(
          await callTool(connection, "get-oauth-access-token", {
            authorizationId: "no-such-authorization",
          }),
          "get-oauth-access-token unknown authorization",
          "not connected",
        );
        // A token with less than the requested validity left is refreshed before it is returned.
        const short = await authorize(ctx, appId, { label: "short" });
        expectStatus(
          await ctx.api("GET", `/api/oauth/callback?state=${short.state}&code=short`, {
            apiKey: null,
          }),
          [200],
          "connect a short-lived authorization",
        );
        const shortRow = asRecords(
          (await ctx.api("GET", `/api/oauth-apps/${appId}/authorizations`)).json,
          "authorizations",
        ).find((r) => r.label === "short");
        const shortIssued = tokenRequests(provider, "authorization_code").find(
          (r) => r.form.get("code") === "short",
        );
        expect(shortRow && shortIssued, "the short-lived authorization is connected");
        const refreshesBefore = tokenRequests(provider, "refresh_token").length;
        const nearExpiry = expectToolOk(
          await callTool(connection, "get-oauth-access-token", {
            authorizationId: String(shortRow.id),
          }),
          "get-oauth-access-token near expiry",
        );
        expect(
          tokenRequests(provider, "refresh_token").length === refreshesBefore + 1 &&
            /^at-\d+$/.test(String(nearExpiry.data.accessToken)),
          "a token with less than five minutes left is refreshed before it is returned",
        );
        expect(
          (await callTool(connection, "get-oauth-access-token", { provider: "bad provider!" }))
            .isError,
          "the tool rejects a non-slug provider",
        );
      } finally {
        await connection.close();
      }

      // ── disconnect, revoke, delete ─────────────────────────────────────────
      const revokeBefore = provider.requests.filter((r) => r.path === "/revoke").length;
      const disconnected = await ctx.api("DELETE", `/api/oauth-apps/${providerSlug}/tokens`);
      expectStatus(disconnected, [200], "disconnect the default authorization");
      expect(
        asRecord(disconnected.json).disconnected === true &&
          asRecord(disconnected.json).revocationAttempted === true,
        "disconnect revokes remotely",
      );
      const revoked = provider.requests.filter((r) => r.path === "/revoke");
      expect(
        revoked.length === revokeBefore + 1 &&
          /^at-\d+$/.test(revoked[revokeBefore]?.form.get("token") ?? ""),
        "the provider received the revoked access token",
      );
      expect(
        asRecords(
          (await ctx.api("GET", `/api/oauth-apps/${appId}/authorizations`)).json,
          "authorizations",
        ).find((r) => r.label === "default")?.status === "revoked",
        "a disconnected authorization is kept as revoked",
      );
      const again = await ctx.api("DELETE", `/api/oauth-apps/${providerSlug}/tokens`);
      expect(
        asRecord(again.json).disconnected === false &&
          asRecord(again.json).message === "no stored tokens",
        "disconnecting twice reports no stored tokens",
      );
      expectStatus(
        await ctx.api("POST", `/api/oauth-apps/${providerSlug}/refresh`),
        [400],
        "refresh a disconnected provider",
      );
      expectStatus(
        await ctx.api("DELETE", "/api/oauth-apps/no-such-provider/tokens"),
        [404],
        "disconnect an unknown provider",
      );

      const workId = String(byLabel("work")?.id);
      const deleted = await ctx.api("DELETE", `/api/oauth-authorizations/${workId}`);
      expectStatus(deleted, [200], "delete an authorization");
      expect(
        asRecord(deleted.json).deleted === true &&
          asRecord(deleted.json).revocationAttempted === true,
        "delete revokes remotely first",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/oauth-authorizations/${workId}`),
        [404],
        "delete an authorization twice",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM oauth_authorizations WHERE id = ?", [workId]) === null,
        "the authorization row is gone",
      );

      expectStatus(
        await ctx.api("DELETE", `/api/oauth-apps/${providerSlug}`),
        [200],
        "delete the app",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM oauth_apps WHERE id = ?", [appId]) === null,
        "the app row is gone",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM oauth_authorizations WHERE appId = ?", [appId]) === null,
        "deleting an app deletes its authorizations",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/oauth-apps/${providerSlug}`),
        [404],
        "delete the app twice",
      );

      // ── integrations catalog (proxied from integrations.sh) ────────────────
      // The upstream is a public service, so the catalog either relays it or falls back to the
      // built-in entries; both are 200 with the documented envelope.
      const catalog = await ctx.api("GET", "/api/integrations-catalog");
      expectStatus(catalog, [200], "integrations catalog");
      const catalogBody = asRecord(catalog.json);
      expect(
        Array.isArray(catalogBody.entries) &&
          typeof catalogBody.cachedAt === "string" &&
          typeof catalogBody.partial === "boolean",
        "the catalog answers entries, cachedAt and partial",
      );
      for (const entry of asRecords(catalogBody, "entries").slice(0, 5)) {
        expect(
          typeof entry.id === "string" &&
            typeof entry.name === "string" &&
            typeof entry.domain === "string",
          "catalog entries have id, name and domain",
        );
      }
      expectStatus(
        await ctx.api("GET", "/api/integrations-catalog", { apiKey: null }),
        [401],
        "catalog unauth",
      );
      const surface = await ctx.api(
        "GET",
        `/api/integrations-catalog/${providerSlug}.invalid/surface`,
      );
      expectStatus(surface, [404, 502], "surface of a domain that does not exist");
      expectStatus(
        await ctx.api("GET", "/api/integrations-catalog/not%20a%20domain/surface"),
        [400],
        "surface with an invalid domain",
      );
    } finally {
      await cleanup.run();
    }
  },
};

export const platformOauthLocks: Scenario = {
  name: "platform-oauth-locks",
  order: 635,
  async run(ctx) {
    const key = `e2e-lock-${ctx.nonce}`;
    expectStatus(
      await ctx.api("POST", `/api/oauth/refresh-locks/${key}`, {
        apiKey: null,
        body: { ttlMs: 1000 },
      }),
      [401],
      "acquire unauth",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/oauth/refresh-locks/${key}`, {
        apiKey: null,
        body: { owner: "x" },
      }),
      [401],
      "release unauth",
    );
    expectStatus(
      await ctx.api("POST", `/api/oauth/refresh-locks/${key}`, { body: { ttlMs: 0 } }),
      [400],
      "ttl of zero",
    );
    expectStatus(
      await ctx.api("POST", `/api/oauth/refresh-locks/${key}`, { body: { ttlMs: 300_001 } }),
      [400],
      "ttl above five minutes",
    );
    expectStatus(
      await ctx.api("POST", `/api/oauth/refresh-locks/${key}`, { body: { ttlMs: 1.5 } }),
      [400],
      "fractional ttl",
    );
    expectStatus(
      await ctx.api("POST", `/api/oauth/refresh-locks/${key}`, { body: {} }),
      [400],
      "no ttl",
    );
    expectStatus(
      await ctx.api("POST", "/api/oauth/refresh-locks/bad%20key%21", { body: { ttlMs: 1000 } }),
      [400],
      "a key outside the allowed alphabet",
    );

    const first = await ctx.api("POST", `/api/oauth/refresh-locks/${key}`, {
      body: { ttlMs: 60_000 },
    });
    expectStatus(first, [200], "acquire a lock");
    const owner = String(asRecord(first.json).owner);
    expect(owner.length > 0, "acquire returns an owner token");
    expect(
      ctx.db.get<{ owner: string }>("SELECT owner FROM oauth_refresh_locks WHERE lockKey = ?", [
        key,
      ])?.owner === owner,
      "the lock is persisted",
    );
    const contended = await ctx.api("POST", `/api/oauth/refresh-locks/${key}`, {
      body: { ttlMs: 60_000 },
    });
    expectStatus(contended, [409], "acquire a held lock");
    expect(
      String(asRecord(contended.json).error).includes("held"),
      "the 409 says the lock is held",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/oauth/refresh-locks/${key}`, { body: {} }),
      [400],
      "release without an owner",
    );
    // Releasing with someone else's owner token is a no-op.
    expectStatus(
      await ctx.api("DELETE", `/api/oauth/refresh-locks/${key}`, {
        body: { owner: "someone-else" },
      }),
      [204],
      "release with the wrong owner",
    );
    expectStatus(
      await ctx.api("POST", `/api/oauth/refresh-locks/${key}`, { body: { ttlMs: 1000 } }),
      [409],
      "the lock is still held after a wrong-owner release",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/oauth/refresh-locks/${key}`, { body: { owner } }),
      [204],
      "release with the owner",
    );
    const second = await ctx.api("POST", `/api/oauth/refresh-locks/${key}`, { body: { ttlMs: 1 } });
    expectStatus(second, [200], "reacquire a released lock");
    expect(asRecord(second.json).owner !== owner, "a new acquire gets a new owner token");
    // A lock whose ttl passed is taken over by the next caller.
    let takenOver: string | undefined;
    const expired = await pollUntil(
      async () => {
        const response = await ctx.api("POST", `/api/oauth/refresh-locks/${key}`, {
          body: { ttlMs: 60_000 },
        });
        if (response.status === 200) takenOver = String(asRecord(response.json).owner);
        return response.status === 200;
      },
      5_000,
      50,
    );
    expect(expired && takenOver, "an expired lock can be acquired by another caller");
    expectStatus(
      await ctx.api("DELETE", `/api/oauth/refresh-locks/${key}`, { body: { owner: takenOver } }),
      [204],
      "release the takeover lock",
    );
  },
};
