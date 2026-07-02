import type { Agent } from "../types";

export interface SlackMessageContext {
  channelId: string;
  threadTs?: string;
  userId: string;
  text: string;
  botUserId: string;
}

export interface AgentMatch {
  agent: Agent;
  matchedText: string;
}

export interface SlackConfig {
  botToken: string;
  appToken: string;
  signingSecret?: string;
}
