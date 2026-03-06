import { postMessage } from "../../be/db";
import type { NodeResult } from "../engine";
import { interpolate } from "../template";

export interface SendMessageConfig {
  channelId?: string;
  template: string;
}

export function executeSendMessage(
  config: SendMessageConfig,
  ctx: Record<string, unknown>,
): NodeResult {
  const message = interpolate(config.template, ctx);
  if (config.channelId) {
    postMessage(config.channelId, null, message);
  }
  return { mode: "instant", nextPort: "default", output: { message } };
}
