import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  callTool,
  cancelTask,
  dbCount,
  ensureLead,
  expectToolError,
  expectToolOk,
  registerAgent,
} from "./knowledge-helpers";

/** `Cookie` header value built from the non-expiring cookies of a Set-Cookie response. */
function cookieHeader(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => pair.includes("=") && !pair.endsWith("="))
    .join("; ");
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`user:${password}`).toString("base64")}`;
}

async function createPage(
  ctx: ScenarioContext,
  agentId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; json: Record<string, unknown> }> {
  const response = await ctx.api("POST", "/api/pages", { agentId, body });
  expectStatus(response, [201], `create page ${String(body.slug ?? body.title)}`);
  const json = asRecord(response.json);
  return { id: asString(json.id, "page id"), json };
}

export const knowledgePages: Scenario = {
  name: "knowledge-pages",
  order: 540,
  async run(ctx) {
    const owner = await registerAgent(ctx, "page-owner");
    const other = await registerAgent(ctx, "page-other");
    const lead = await ensureLead(ctx);
    const sessionOwner = await ctx.connectMcp(owner);
    const sessionOther = await ctx.connectMcp(other);
    const sessionLead = await ctx.connectMcp(lead);
    const cleanupPages: string[] = [];
    const cleanupTasks: string[] = [];
    try {
      // ── Create ──────────────────────────────────────────────────────────────────────────────
      const marker = `marker-${ctx.nonce}`;
      const htmlBody = `<!doctype html><html><head><title>E2E</title></head><body><h1>${marker}</h1></body></html>`;
      const pub = await createPage(ctx, owner, {
        slug: `e2e-pub-${ctx.nonce}`,
        title: `Public page ${ctx.nonce}`,
        description: "public html page",
        contentType: "text/html",
        authMode: "public",
        body: htmlBody,
      });
      cleanupPages.push(pub.id);
      expect(/^[0-9a-f]{32}$/.test(pub.id), "page id is 32 hex characters (a dashless UUID)");
      expect(pub.json.version === 1, "a new page starts at version 1");
      expect(
        typeof pub.json.key === "string" && String(pub.json.key).endsWith("/"),
        `default asset key: ${String(pub.json.key)}`,
      );
      expect(
        String(pub.json.api_url).endsWith(`/p/${pub.id}`) &&
          String(pub.json.app_url).endsWith(`/pages/e2e-pub-${ctx.nonce}`),
        "share URL pointers",
      );
      const row = ctx.db.get<{
        agentId: string;
        slug: string;
        authMode: string;
        contentType: string;
        view_count: number;
      }>("SELECT agentId, slug, authMode, contentType, view_count FROM pages WHERE id = ?", [
        pub.id,
      ]);
      expect(
        row?.agentId === owner && row.authMode === "public" && row.contentType === "text/html",
        "page row was not persisted",
      );

      let response = await ctx.api("POST", "/api/pages", {
        agentId: owner,
        body: {
          slug: `e2e-pub-${ctx.nonce}`,
          title: "dup",
          contentType: "text/html",
          authMode: "public",
          body: "x",
        },
      });
      expectStatus(response, [409], "duplicate slug for the same agent");
      response = await ctx.api("POST", "/api/pages", {
        body: { title: "no agent", contentType: "text/html", body: "x" },
      });
      expectStatus(response, [400], "create page without X-Agent-ID");
      response = await ctx.api("POST", "/api/pages", {
        agentId: owner,
        body: { title: "bad type", contentType: "text/plain", body: "x" },
      });
      expectStatus(response, [400], "create page with an invalid contentType");
      response = await ctx.api("POST", "/api/pages", {
        agentId: owner,
        body: { contentType: "text/html", body: "x" },
      });
      expectStatus(response, [400], "create page without a title");
      response = await ctx.api("POST", "/api/pages", {
        agentId: owner,
        body: {
          title: "personal key",
          contentType: "text/html",
          body: "x",
          key: `personal/${crypto.randomUUID()}/drafts/`,
        },
      });
      expectStatus(response, [400], "create page in a personal namespace of an unknown user");

      // Derived slug and the default auth mode.
      const derived = await createPage(ctx, owner, {
        title: `Derived Slug ${ctx.nonce}!`,
        contentType: "text/html",
        body: "<p>derived</p>",
        key: `shared/e2e-${ctx.nonce}/pages/`,
      });
      cleanupPages.push(derived.id);
      expect(derived.json.key === `shared/e2e-${ctx.nonce}/pages/`, "explicit key is kept");
      response = await ctx.api("GET", `/api/pages/${derived.id}`, { agentId: owner });
      expectStatus(response, [200], "get the derived page");
      const derivedPage = asRecord(response.json);
      expect(derivedPage.slug === `derived-slug-${ctx.nonce}`, "slug derives from the title");
      expect(derivedPage.authMode === "authed", "authMode defaults to authed");

      // ── Public serving: /p/{id} and /p/{id}.json ────────────────────────────────────────────
      response = await ctx.api("GET", `/p/${pub.id}`, { apiKey: null });
      expectStatus(response, [200], "serve a public page without credentials");
      expect(
        response.headers.get("content-type")?.startsWith("text/html") === true,
        "public html content type",
      );
      expect(response.text.includes(marker), "the page body is served verbatim");
      expect(
        response.text.includes("swarmSdk") &&
          response.text.indexOf("<script") < response.text.indexOf(marker),
        "the browser SDK is injected into <head>",
      );
      expect(
        response.headers.get("x-content-type-options") === "nosniff" &&
          response.headers.get("cache-control") === "no-store" &&
          (response.headers.get("content-security-policy") ?? "").includes("frame-ancestors"),
        "page security headers",
      );
      response = await ctx.api("GET", `/p/${pub.id}?print=1`, { apiKey: null });
      expect(response.text.includes("window.print"), "?print=1 appends the self-print snippet");
      response = await ctx.api("GET", `/p/${pub.id}?__swarm-feedback=1`, { apiKey: null });
      expectStatus(response, [200], "serve with the feedback overlay");
      expect(response.text.includes(pub.id), "the feedback overlay is bound to the page id");
      const counted = await pollUntil(
        () =>
          (ctx.db.get<{ view_count: number }>("SELECT view_count FROM pages WHERE id = ?", [pub.id])
            ?.view_count ?? 0) >= 3,
        5_000,
        100,
      );
      expect(counted, "each served page must bump view_count (the bump runs after the response)");
      response = await ctx.api("GET", `/p/${pub.id}.json`, { apiKey: null });
      expectStatus(response, [200], "public page JSON");
      const publicJson = asRecord(response.json);
      expect(
        publicJson.id === pub.id &&
          publicJson.version === 1 &&
          publicJson.body === htmlBody &&
          publicJson.contentType === "text/html" &&
          publicJson.authMode === "public" &&
          publicJson.passwordHash === undefined &&
          publicJson.agentId === undefined,
        `public JSON shape must not leak private fields: ${JSON.stringify(publicJson).slice(0, 200)}`,
      );
      response = await ctx.api("GET", `/p/${crypto.randomUUID()}`, { apiKey: null });
      expectStatus(response, [404], "serve an unknown page");
      response = await ctx.api("GET", `/p/${crypto.randomUUID()}.json`, { apiKey: null });
      expectStatus(response, [404], "serve an unknown page as JSON");

      const svgBody = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>${marker}</title></svg>`;
      const svg = await createPage(ctx, owner, {
        slug: `e2e-svg-${ctx.nonce}`,
        title: "SVG page",
        contentType: "image/svg+xml",
        authMode: "public",
        body: svgBody,
      });
      cleanupPages.push(svg.id);
      response = await ctx.api("GET", `/p/${svg.id}?print=1`, { apiKey: null });
      expectStatus(response, [200], "serve an SVG page");
      expect(
        response.headers.get("content-type") === "image/svg+xml" &&
          response.text === svgBody &&
          (response.headers.get("content-security-policy") ?? "").includes("sandbox"),
        "SVG is served byte for byte under a sandbox CSP, even with ?print=1",
      );

      const jsonBody = JSON.stringify({
        root: "r",
        elements: { r: { type: "Container", props: {} } },
      });
      const jsonPage = await createPage(ctx, owner, {
        slug: `e2e-json-${ctx.nonce}`,
        title: "JSON page",
        contentType: "application/json",
        authMode: "public",
        body: jsonBody,
      });
      cleanupPages.push(jsonPage.id);
      response = await ctx.api("GET", `/p/${jsonPage.id}`, { apiKey: null, redirect: "manual" });
      expectStatus(response, [302], "a JSON page redirects to the SPA");
      expect(
        (response.headers.get("location") ?? "").endsWith(`/pages/${jsonPage.id}`),
        "redirect target",
      );
      response = await ctx.api("GET", `/p/${jsonPage.id}?print=1`, { apiKey: null });
      expectStatus(response, [200], "a JSON page prints standalone");
      expect(
        response.text.includes("window.print") && response.text.includes("Container"),
        "printable JSON document",
      );

      // ── authed pages: 401 until a launch cookie exists ──────────────────────────────────────
      const authed = await createPage(ctx, owner, {
        slug: `e2e-authed-${ctx.nonce}`,
        title: "Authed page",
        contentType: "text/html",
        authMode: "authed",
        body: `<html><head></head><body>${marker}-authed</body></html>`,
      });
      cleanupPages.push(authed.id);
      response = await ctx.api("GET", `/p/${authed.id}`, { apiKey: null });
      expectStatus(response, [401], "an authed page without a session");
      response = await ctx.api("GET", `/p/${authed.id}.json`, { apiKey: null });
      expectStatus(response, [401], "an authed page as JSON without a session");
      response = await ctx.api("POST", `/api/pages/${authed.id}/launch`);
      expectStatus(response, [204], "launch an authed page");
      const authedCookies = cookieHeader(response.headers);
      expect(
        authedCookies.startsWith(`page_session_${authed.id}=`),
        `launch must set a page_session cookie: ${authedCookies.slice(0, 80)}`,
      );
      response = await ctx.api("GET", `/p/${authed.id}`, {
        apiKey: null,
        headers: { Cookie: authedCookies },
      });
      expectStatus(response, [200], "an authed page with its session cookie");
      expect(response.text.includes(`${marker}-authed`), "authed page body");
      response = await ctx.api("GET", `/p/${pub.id}`, {
        apiKey: null,
        headers: { Cookie: authedCookies },
      });
      expectStatus(response, [200], "a public page ignores a foreign session cookie");
      const secondAuthed = await createPage(ctx, owner, {
        slug: `e2e-authed2-${ctx.nonce}`,
        title: "Second authed page",
        contentType: "text/html",
        authMode: "authed",
        body: "<html><head></head><body>second</body></html>",
      });
      cleanupPages.push(secondAuthed.id);
      response = await ctx.api("GET", `/p/${secondAuthed.id}`, {
        apiKey: null,
        headers: { Cookie: authedCookies },
      });
      expectStatus(response, [403], "a session cookie for a different page");
      response = await ctx.api("GET", `/p/${secondAuthed.id}`, { apiKey: null });
      expectStatus(response, [401], "no session cookie at all");
      response = await ctx.api("POST", `/api/pages/${crypto.randomUUID()}/launch`);
      expectStatus(response, [404], "launch an unknown page");

      // ── password pages: ?key=, Basic auth, cookie ───────────────────────────────────────────
      const password = `pw-${ctx.nonce}`;
      const locked = await createPage(ctx, owner, {
        slug: `e2e-locked-${ctx.nonce}`,
        title: "Password page",
        contentType: "text/html",
        authMode: "password",
        password,
        body: `<html><head></head><body>${marker}-locked</body></html>`,
      });
      cleanupPages.push(locked.id);
      response = await ctx.api("GET", `/p/${locked.id}`, { apiKey: null });
      expectStatus(response, [401], "a password page without a password");
      expect(
        (response.headers.get("www-authenticate") ?? "").startsWith("Basic realm="),
        "WWW-Authenticate asks for Basic auth",
      );
      response = await ctx.api("GET", `/p/${locked.id}?key=wrong`, { apiKey: null });
      expectStatus(response, [401], "a password page with a wrong password");
      expect(asRecord(response.json).error === "incorrect password", "wrong password message");
      response = await ctx.api("GET", `/p/${locked.id}?key=${encodeURIComponent(password)}`, {
        apiKey: null,
      });
      expectStatus(response, [200], "a password page with ?key=");
      expect(response.text.includes(`${marker}-locked`), "password page body");
      const lockedCookies = cookieHeader(response.headers);
      expect(
        lockedCookies.startsWith(`page_session_${locked.id}=`),
        "?key= mints a session cookie",
      );
      response = await ctx.api("GET", `/p/${locked.id}`, {
        apiKey: null,
        headers: { Cookie: lockedCookies },
      });
      expectStatus(response, [200], "a password page with its cookie");
      response = await ctx.api("GET", `/p/${locked.id}`, {
        apiKey: null,
        headers: { Authorization: basicAuth(password) },
      });
      expectStatus(response, [200], "a password page with Basic auth");
      response = await ctx.api("GET", `/p/${locked.id}`, {
        apiKey: null,
        headers: { Authorization: basicAuth("nope") },
      });
      expectStatus(response, [401], "a password page with a wrong Basic password");
      response = await ctx.api("GET", `/p/${locked.id}.json?key=${encodeURIComponent(password)}`, {
        apiKey: null,
      });
      expectStatus(response, [200], "password page JSON with ?key=");
      response = await ctx.api("POST", `/api/pages/${locked.id}/launch`);
      expectStatus(response, [400], "bearer launch is refused for a password page");

      // ── REST reads: get, resolve, list, actions ─────────────────────────────────────────────
      response = await ctx.api("GET", `/api/pages/${pub.id}`, { agentId: owner });
      expectStatus(response, [200], "get a page as its owner");
      const fullPage = asRecord(response.json);
      expect(
        fullPage.id === pub.id &&
          fullPage.body === htmlBody &&
          fullPage.slug === `e2e-pub-${ctx.nonce}` &&
          fullPage.title === `Public page ${ctx.nonce}` &&
          fullPage.description === "public html page" &&
          typeof fullPage.api_url === "string" &&
          typeof fullPage.app_url === "string",
        `page row: ${JSON.stringify(fullPage).slice(0, 300)}`,
      );
      response = await ctx.api("GET", `/api/pages/${pub.id}`);
      expectStatus(response, [200], "get a page as the operator");
      response = await ctx.api("GET", `/api/pages/${pub.id}`, { agentId: other });
      expectStatus(response, [403], "get another agent's page");
      response = await ctx.api("GET", `/api/pages/${crypto.randomUUID()}`);
      expectStatus(response, [404], "get an unknown page");

      response = await ctx.api(
        "GET",
        `/api/pages/resolve?slug=e2e-pub-${ctx.nonce}&agentId=${owner}`,
      );
      expectStatus(response, [200], "resolve a page by slug and agent");
      expect(asRecord(response.json).id === pub.id, "resolve by slug and agent");
      response = await ctx.api("GET", `/api/pages/resolve?slug=e2e-pub-${ctx.nonce}`);
      expectStatus(response, [200], "resolve a page by slug alone");
      expect(asRecord(response.json).id === pub.id, "resolve by slug alone");
      response = await ctx.api("GET", `/api/pages/resolve?slug=missing-${ctx.nonce}`);
      expectStatus(response, [404], "resolve an unknown slug");
      response = await ctx.api("GET", "/api/pages/resolve");
      expectStatus(response, [400], "resolve without a slug");

      response = await ctx.api("GET", `/api/pages?agentId=${owner}&limit=2&offset=0`);
      expectStatus(response, [200], "list pages by agent");
      let listing = asRecord(response.json);
      expect(
        listing.limit === 2 &&
          listing.offset === 0 &&
          listing.total ===
            dbCount(ctx, "SELECT count(*) AS n FROM pages WHERE agentId = ?", [owner]) &&
          asRecords(listing, "pages").length === 2 &&
          asRecords(listing, "pages").every((page) => page.body === undefined),
        `slim page list with a real total: ${JSON.stringify({ total: listing.total, limit: listing.limit })}`,
      );
      response = await ctx.api("GET", `/api/pages?agentId=${owner}&fields=full&q=Derived`);
      listing = asRecord(response.json);
      expect(
        asRecords(listing, "pages").length === 1 &&
          asRecords(listing, "pages")[0]?.id === derived.id &&
          typeof asRecords(listing, "pages")[0]?.body === "string",
        "q filter plus fields=full",
      );
      response = await ctx.api(
        "GET",
        `/api/pages?keyPrefix=${encodeURIComponent(`shared/e2e-${ctx.nonce}/`)}`,
      );
      expect(
        asRecords(response.json, "pages")
          .map((page) => page.id)
          .join() === derived.id,
        "keyPrefix filter",
      );
      response = await ctx.api("GET", `/api/pages?key=${encodeURIComponent(String(pub.json.key))}`);
      expect(
        asRecords(response.json, "pages")
          .map((page) => page.id)
          .join() === pub.id,
        "exact key filter",
      );
      response = await ctx.api("GET", "/api/pages?limit=0");
      expectStatus(response, [400], "list pages with an invalid limit");

      response = await ctx.api("GET", "/api/pages/actions");
      expectStatus(response, [200], "page action allowlist");
      const actions = asRecords(response.json, "actions");
      expect(
        actions
          .map((action) => action.name)
          .sort()
          .join() === "swarm.call,swarm.sdk" &&
          Array.isArray(actions.find((action) => action.name === "swarm.sdk")?.sdkMethods),
        "page actions",
      );

      // ── Update + version history ────────────────────────────────────────────────────────────
      response = await ctx.api("PUT", `/api/pages/${pub.id}`, {
        agentId: owner,
        body: { title: "Public page v2", body: `${htmlBody}<!-- v2 -->`, description: null },
      });
      expectStatus(response, [200], "update a page");
      expect(
        asRecord(response.json).id === pub.id && asRecord(response.json).version === 2,
        `update result: ${response.text}`,
      );
      response = await ctx.api("PUT", `/api/pages/${pub.id}`, {
        agentId: owner,
        body: { body: `${htmlBody}<!-- v3 -->`, authMode: "public" },
      });
      expect(asRecord(response.json).version === 3, "a second update is version 3");
      response = await ctx.api("GET", `/api/pages/${pub.id}/versions`, { agentId: owner });
      expectStatus(response, [200], "list page versions");
      const versions = asRecords(response.json, "versions");
      expect(
        versions.map((version) => version.version).join() === "2,1",
        `versions are newest first: ${versions.map((version) => version.version).join()}`,
      );
      response = await ctx.api("GET", `/api/pages/${pub.id}/versions/1`, { agentId: owner });
      expectStatus(response, [200], "get version 1");
      const snapshot = asRecord(asRecord(response.json).snapshot);
      expect(
        snapshot.body === htmlBody && snapshot.title === `Public page ${ctx.nonce}`,
        "version 1 holds the original content",
      );
      response = await ctx.api("GET", `/api/pages/${pub.id}/versions/99`, { agentId: owner });
      expectStatus(response, [404], "get an unknown version");
      response = await ctx.api("GET", `/api/pages/${pub.id}/versions/0`, { agentId: owner });
      expectStatus(response, [400], "get version 0");
      response = await ctx.api("GET", `/api/pages/${pub.id}/versions`, { agentId: other });
      expectStatus(response, [403], "list versions of another agent's page");
      response = await ctx.api("GET", `/api/pages/${pub.id}/versions/1`, { agentId: other });
      expectStatus(response, [403], "get a version of another agent's page");
      response = await ctx.api("GET", `/api/pages/${crypto.randomUUID()}/versions`);
      expectStatus(response, [404], "list versions of an unknown page");
      response = await ctx.api("GET", `/api/pages/${crypto.randomUUID()}/versions/1`);
      expectStatus(response, [404], "get a version of an unknown page");
      response = await ctx.api("PUT", `/api/pages/${pub.id}`, {
        agentId: other,
        body: { title: "hijack" },
      });
      expectStatus(response, [403], "update another agent's page");
      response = await ctx.api("PUT", `/api/pages/${crypto.randomUUID()}`, {
        body: { title: "x" },
      });
      expectStatus(response, [404], "update an unknown page");
      response = await ctx.api("PUT", `/api/pages/${pub.id}`, {
        agentId: owner,
        body: { contentType: "text/plain" },
      });
      expectStatus(response, [400], "update with an invalid contentType");
      response = await ctx.api("PUT", `/api/pages/${pub.id}`, {
        agentId: owner,
        body: { body: "x".repeat(5 * 1024 * 1024 + 1) },
      });
      expectStatus(response, [413], "update with a body above 5 MiB");
      response = await ctx.api("PUT", `/api/pages/${locked.id}`, {
        agentId: owner,
        body: { password: null, authMode: "public" },
      });
      expectStatus(response, [200], "clear a page password");
      response = await ctx.api("GET", `/p/${locked.id}`, { apiKey: null });
      expectStatus(response, [200], "the unlocked page is public now");
      response = await ctx.api("GET", `/p/${pub.id}.json`, { apiKey: null });
      expect(
        String(asRecord(response.json).body).includes("<!-- v3 -->") &&
          asRecord(response.json).title === "Public page v2",
        "the served page reflects the update",
      );

      // ── Feedback: overlay comments become one lead task ─────────────────────────────────────
      response = await ctx.api("POST", `/api/pages/${pub.id}/feedback`, {
        body: {
          pageUrl: `http://localhost/p/${pub.id}`,
          note: `Overall ${marker}`,
          comments: [
            { selector: "h1", comment: `Make the heading bigger ${marker}`, tagName: "h1" },
            { selector: "p.intro", comment: "Typo here", text: "Helo wrld" },
          ],
        },
      });
      expectStatus(response, [201], "send page feedback");
      const feedback = asRecord(response.json);
      const feedbackTask = asString(feedback.taskId, "feedback task id");
      cleanupTasks.push(feedbackTask);
      expect(
        typeof feedback.status === "string" &&
          String(feedback.task_url).endsWith(`/tasks/${feedbackTask}`),
        "feedback response",
      );
      response = await ctx.api("GET", `/api/tasks/${feedbackTask}`);
      expectStatus(response, [200], "read the feedback task");
      const taskDoc = asRecord(response.json);
      expect(
        taskDoc.taskType === "page-feedback" &&
          taskDoc.source === "ui" &&
          String(taskDoc.task).includes(`Make the heading bigger ${marker}`) &&
          String(taskDoc.task).includes("p.intro") &&
          String(taskDoc.contextKey).startsWith(`task:ui:page:${pub.id}:`),
        `feedback task: ${JSON.stringify(taskDoc).slice(0, 300)}`,
      );
      response = await ctx.api("POST", `/api/pages/${pub.id}/feedback`, {
        body: { comments: [] },
      });
      expectStatus(response, [400], "feedback without comments");
      response = await ctx.api("POST", `/api/pages/${pub.id}/feedback`, {
        body: { comments: [{ selector: "h1", comment: "   " }] },
      });
      expectStatus(response, [400], "feedback with a blank comment");
      response = await ctx.api("POST", `/api/pages/${pub.id}/feedback`, {
        body: {
          comments: [{ selector: "h1", comment: "ok" }],
          contextKey: `task:ui:page:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        },
      });
      expectStatus(response, [400], "feedback with another page's context key");
      response = await ctx.api("POST", `/api/pages/${pub.id}/feedback`, {
        headers: { "X-Page-Id": crypto.randomUUID() },
        body: { comments: [{ selector: "h1", comment: "ok" }] },
      });
      expectStatus(response, [403], "feedback scoped to a different page session");
      response = await ctx.api("POST", `/api/pages/${crypto.randomUUID()}/feedback`, {
        body: { comments: [{ selector: "h1", comment: "ok" }] },
      });
      expectStatus(response, [404], "feedback for an unknown page");

      // ── MCP create_page / delete-page ───────────────────────────────────────────────────────
      const toolSlug = `e2e-tool-${ctx.nonce}`;
      let outcome = expectToolOk(
        await callTool(sessionOwner, "create_page", {
          title: "Tool page",
          slug: toolSlug,
          body: "<html><head></head><body>tool v1</body></html>",
          contentType: "text/html",
          authMode: "public",
          needsCredentials: [{ name: "TOKEN", description: "a token" }],
        }),
        "create_page",
      );
      const toolPageId = asString(outcome.data.id, "tool page id");
      cleanupPages.push(toolPageId);
      expect(
        outcome.data.version === 1 &&
          String(outcome.data.api_url).endsWith(`/p/${toolPageId}`) &&
          String(outcome.data.app_url).endsWith(`/pages/${toolPageId}`),
        "create_page result",
      );
      outcome = expectToolOk(
        await callTool(sessionOwner, "create_page", {
          title: "Tool page v2",
          slug: toolSlug,
          body: "<html><head></head><body>tool v2</body></html>",
          contentType: "text/html",
          authMode: "public",
        }),
        "create_page upsert",
      );
      expect(
        outcome.data.id === toolPageId && outcome.data.version === 2,
        "create_page with the same slug updates the page and snapshots it",
      );
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM page_versions WHERE pageId = ?", [toolPageId]) ===
          1,
        "the upsert must snapshot the previous state",
      );
      response = await ctx.api("GET", `/p/${toolPageId}`, { apiKey: null });
      expect(response.text.includes("tool v2"), "create_page upsert is what is served");
      expectToolError(
        await callTool(sessionOwner, "create_page", {
          title: "Bad key",
          body: "x",
          contentType: "text/html",
          key: `personal/${crypto.randomUUID()}/x/`,
        }),
        "create_page with a personal key of an unknown user",
        /user|namespace|personal/i,
      );

      expectToolError(
        await callTool(sessionOwner, "delete-page", {}),
        "delete-page without a target",
        /pageId or slug/i,
      );
      expectToolError(
        await callTool(sessionOwner, "delete-page", { pageId: crypto.randomUUID() }),
        "delete-page unknown",
        /not found/i,
      );
      expectToolError(
        await callTool(sessionOther, "delete-page", { pageId: toolPageId }),
        "delete-page by a non-owner",
        /lead or page owner/i,
      );
      outcome = expectToolOk(
        await callTool(sessionOwner, "delete-page", { slug: toolSlug }),
        "delete-page by slug",
      );
      expect(asRecord(outcome.data.deletedPage).id === toolPageId, "delete-page result");
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM pages WHERE id = ?", [toolPageId]) === 0 &&
          dbCount(ctx, "SELECT count(*) AS n FROM page_versions WHERE pageId = ?", [toolPageId]) ===
            0,
        "deleting a page cascades to its versions",
      );
      expectToolOk(
        await callTool(sessionLead, "delete-page", { pageId: svg.id }),
        "delete-page by the lead on another agent's page",
      );
      cleanupPages.splice(cleanupPages.indexOf(svg.id), 1);

      // ── HTTP delete ─────────────────────────────────────────────────────────────────────────
      response = await ctx.api("DELETE", `/api/pages/${jsonPage.id}`, { agentId: other });
      expectStatus(response, [403], "delete another agent's page");
      response = await ctx.api("DELETE", `/api/pages/${jsonPage.id}`, { agentId: owner });
      expectStatus(response, [204], "delete a page");
      cleanupPages.splice(cleanupPages.indexOf(jsonPage.id), 1);
      response = await ctx.api("DELETE", `/api/pages/${jsonPage.id}`, { agentId: owner });
      expectStatus(response, [404], "delete a page twice");
      response = await ctx.api("GET", `/p/${jsonPage.id}`, { apiKey: null });
      expectStatus(response, [404], "a deleted page is gone");
      response = await ctx.api("DELETE", `/api/pages/${pub.id}`);
      expectStatus(response, [204], "the operator deletes any page");
      cleanupPages.splice(cleanupPages.indexOf(pub.id), 1);
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM page_versions WHERE pageId = ?", [pub.id]) === 0,
        "deleting a page deletes its version history",
      );
    } finally {
      for (const id of cleanupPages) await ctx.api("DELETE", `/api/pages/${id}`);
      for (const id of cleanupTasks) await cancelTask(ctx, id).catch(() => {});
      await sessionLead.close();
      await sessionOther.close();
      await sessionOwner.close();
    }
  },
};
