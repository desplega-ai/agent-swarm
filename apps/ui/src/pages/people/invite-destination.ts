/** Compare dashboard origins. Older APIs omit the destination. */
export function inviteDestination(
  appUrl: string | undefined,
  currentOrigin: string,
): { host: string; differentOrigin: boolean } | null {
  if (!appUrl) return null;
  try {
    const url = new URL(appUrl);
    return { host: url.host, differentOrigin: url.origin !== new URL(currentOrigin).origin };
  } catch {
    return null;
  }
}
