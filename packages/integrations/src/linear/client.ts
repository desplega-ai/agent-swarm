import { LinearClient } from "@linear/sdk";
import { getOAuthTokens } from "@swarm/storage";

let linearClient: LinearClient | null = null;

export function getLinearClient(): LinearClient | null {
  const tokens = getOAuthTokens("linear");
  if (!tokens) return null;

  if (!linearClient) {
    linearClient = new LinearClient({ accessToken: tokens.accessToken });
  }
  return linearClient;
}

export function resetLinearClient(): void {
  linearClient = null;
}
