import { join } from "node:path";

// Fake ACP targets run from temp dirs, so they import the SDK by path. The
// unstable v1 entry point lets them return turn `usage` like OpenCode does.
export const ACP_SDK_PATH = join(
  process.cwd(),
  "node_modules/@agentclientprotocol/sdk/dist/v1/unstable/acp.js",
);

/**
 * Script tail that serves a fake agent class over stdio with the SDK's agent
 * app API. The class implements the ACP agent methods and gets
 * `{ sessionUpdate }` to notify the client. The script must import `agent`,
 * `methods`, and `ndJsonStream` from ACP_SDK_PATH, and `Readable`/`Writable`
 * from node:stream.
 */
export function serveFakeAcpAgent(className: string): string {
  return `
const fake = new ${className}({
  sessionUpdate: (params) => connection.client.notify(methods.client.session.update, params),
});
const app = agent()
  .onRequest(methods.agent.initialize, ({ params }) => fake.initialize(params))
  .onRequest(methods.agent.session.new, ({ params }) => fake.newSession(params))
  .onRequest(methods.agent.session.prompt, ({ params }) => fake.prompt(params))
  .onNotification(methods.agent.session.cancel, ({ params }) => fake.cancel(params));
if (fake.setSessionConfigOption) {
  app.onRequest(methods.agent.session.setConfigOption, ({ params }) =>
    fake.setSessionConfigOption(params),
  );
}
const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
`;
}
