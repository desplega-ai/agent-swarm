import { setChatSdkTestHooks } from "../../../integrations/chat-sdk/test-hooks";

// Loaded only by the black-box runner's child process, never by the API entry.
// Teams JWT verification/token acquisition and the Discord Gateway are external edges.
if (process.env.NODE_ENV !== "test" || !process.env.CHAT_SDK_E2E_WEBHOOK_TOKEN) {
  throw new Error("Chat SDK E2E preload requires a test process and webhook token");
}
setChatSdkTestHooks({
  disableDiscordGateway: true,
  teamsWebhookVerifier: (request) =>
    request.headers.get("authorization") === `Bearer ${process.env.CHAT_SDK_E2E_WEBHOOK_TOKEN}`,
  teamsToken: () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none", typ: "JWT" })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  },
});
