import { LinearClient } from "@linear/sdk";
import { getOAuthTokens } from "../be/db-queries/oauth";
import { linearApiUrl } from "./host";

let linearClient: LinearClient | null = null;

export async function getLinearClient(): Promise<LinearClient | null> {
  const tokens = await getOAuthTokens("linear");
  if (!tokens) return null;

  if (!linearClient) {
    linearClient = new LinearClient({
      accessToken: tokens.accessToken,
      apiUrl: linearApiUrl("/graphql"),
    });
  }
  return linearClient;
}

export function resetLinearClient(): void {
  linearClient = null;
}
