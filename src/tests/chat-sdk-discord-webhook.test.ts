import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import {
  type DiscordGatewayListener,
  getDiscordGatewayHealth,
  startDiscordGateway,
} from "../integrations/chat-sdk/discord-gateway";
import { stopChatRelayWatcher } from "../integrations/chat-sdk/relay";
import { getChatSdkHealth, startChatSdk, stopChatSdk } from "../integrations/chat-sdk/runtime";
import { setChatSdkTestHooks } from "../integrations/chat-sdk/test-hooks";
import { postChatWebhook, snapshotChatSdkEnv } from "./chat-sdk-harness";
import { getFreePort } from "./test-net";

/*
 * Network: Discord `initialize()` only resolves the application id (no API
 * call), and a PING is answered from the signature check alone. The Gateway
 * loop is off through the test hook: it logs in through `discord.js`, which
 * ignores `apiUrl` and would reach the real Discord API. `apiUrl` points at a
 * port nothing listens on, so an unexpected REST call fails here.
 */
const TEST_DB_PATH = "./test-chat-sdk-discord-webhook.sqlite";
const restoreEnv = snapshotChatSdkEnv();
let privateKey: CryptoKey;

function toHex(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("hex");
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
}

/** Discord signs `timestamp + body` with the application's Ed25519 key. */
async function signedHeaders(body: string): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(timestamp + body),
  );
  return {
    "content-type": "application/json",
    "x-signature-ed25519": toHex(signature),
    "x-signature-timestamp": timestamp,
  };
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateKey = keyPair.privateKey;
  const publicKey = toHex(await crypto.subtle.exportKey("raw", keyPair.publicKey));

  setChatSdkTestHooks({ disableDiscordGateway: true });
  process.env.CHAT_SDK_ENABLED = "true";
  process.env.CHAT_SDK_ADAPTERS = JSON.stringify({
    discord: { botToken: "discord-test-token", publicKey, applicationId: "1234567890" },
  });
  process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({
    discord: `http://127.0.0.1:${await getFreePort()}/api/v10`,
  });
  await startChatSdk();
  await stopChatRelayWatcher();
});

afterAll(async () => {
  await stopChatSdk();
  setChatSdkTestHooks({});
  restoreEnv();
  closeDb();
  await removeDbFiles();
});

describe("Chat SDK Discord interactions webhook", () => {
  test("the adapter starts without the Gateway loop", () => {
    const health = getChatSdkHealth().discord;
    expect(health?.status).toBe("ok");
    expect(health?.gateway).toBeUndefined();
  });

  test("an unsigned interaction is rejected with 401", async () => {
    const response = await postChatWebhook("discord", JSON.stringify({ type: 1 }), {
      "content-type": "application/json",
    });
    expect(response.status).toBe(401);
  });

  test("a body that does not match its signature is rejected with 401", async () => {
    const headers = await signedHeaders(JSON.stringify({ type: 1 }));
    const response = await postChatWebhook("discord", JSON.stringify({ type: 2 }), headers);
    expect(response.status).toBe(401);
  });

  test("a signed PING is answered with a PONG", async () => {
    const body = JSON.stringify({ type: 1 });
    const response = await postChatWebhook("discord", body, await signedHeaders(body));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ type: 1 });
  });

  // Last in the file: it stops the runtime. `afterAll` stops it again, a no-op.
  test("health shows the Gateway loop while it runs and drops it on shutdown", async () => {
    // A stub listener: the real one logs in to Discord. Its window ends only on abort.
    const gateway: DiscordGatewayListener = {
      async startGatewayListener(options, _durationMs, signal) {
        options.waitUntil?.(
          new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve())),
        );
        return new Response("{}", { status: 200 });
      },
    };
    startDiscordGateway(gateway);
    expect(getChatSdkHealth().discord?.gateway?.state).toBe("running");

    await stopChatSdk();
    expect(getChatSdkHealth().discord).toBeUndefined();
    expect(getDiscordGatewayHealth()).toBeUndefined();
  });
});
