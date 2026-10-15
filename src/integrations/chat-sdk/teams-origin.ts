import { readApiUrlOverrides } from "./config";

/**
 * Bot Framework Connector hosts for Teams: public cloud, GCC, GCC High, DoD
 * and the China cloud. The same set as `TRUSTED_CONNECTOR_HOSTS` in
 * `@chat-adapter/teams` (its standalone connector API), minus the loopback
 * Emulator exception. The adapter's own send path does not check the host.
 */
const TRUSTED_TEAMS_SERVICE_HOSTS = new Set([
  "smba.trafficmanager.net",
  "smba.infra.gcc.teams.microsoft.com",
  "smba.infra.gov.teams.microsoft.us",
  "smba.infra.dod.teams.microsoft.us",
  "msteams.botframework.azure.cn",
]);

/** A Teams service URL that is not a Bot Framework host. Nothing was sent. */
export class UntrustedTeamsServiceUrlError extends Error {
  constructor(detail: string) {
    super(`Refusing to send the Teams bot token: ${detail}`);
    this.name = "UntrustedTeamsServiceUrlError";
  }
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * The Teams adapter sends the bot token to the service URL of the target
 * conversation. Trusted: https on a Bot Framework host, or the origin of the
 * env-only `CHAT_SDK_API_URL_OVERRIDES.teams` (tests and emulators). Every
 * other origin, loopback included, is refused.
 */
export function isTrustedTeamsServiceUrl(serviceUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(serviceUrl);
  } catch {
    return false;
  }
  if (url.protocol === "https:" && TRUSTED_TEAMS_SERVICE_HOSTS.has(url.hostname.toLowerCase())) {
    return true;
  }
  const override = readApiUrlOverrides().teams;
  return override !== undefined && originOf(override) === url.origin;
}

/**
 * Throw `UntrustedTeamsServiceUrlError` unless the Teams thread or channel id
 * (`teams:<base64url conversation>:<base64url serviceUrl>[:<type>]`) carries a
 * trusted service URL. Call it before every Teams call that takes an id from
 * outside the adapter. Ids of other adapters pass.
 */
export function assertTrustedChatTarget(id: string): void {
  const parts = id.split(":");
  if (parts[0] !== "teams") return;
  const encoded = parts[2];
  if ((parts.length !== 3 && parts.length !== 4) || !encoded) {
    throw new UntrustedTeamsServiceUrlError("the Teams id is malformed");
  }
  assertTrustedTeamsServiceUrl(Buffer.from(encoded, "base64url").toString("utf-8"));
}

export function assertTrustedTeamsServiceUrl(serviceUrl: string): void {
  if (isTrustedTeamsServiceUrl(serviceUrl)) return;
  const origin = originOf(serviceUrl);
  throw new UntrustedTeamsServiceUrlError(
    origin && origin !== "null"
      ? `${origin} is not a Microsoft Bot Framework service host`
      : "the service URL is not a valid URL",
  );
}
