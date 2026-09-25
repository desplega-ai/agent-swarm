import manifestSource from "../../slack-manifest.json";

type SlackManifest = typeof manifestSource;

function manifestName(name?: string): string {
  return (name?.trim() || process.env.SWARM_ORG_NAME?.trim() || "Your Swarm").slice(0, 35);
}

export function buildSlackManifest(name?: string): SlackManifest {
  const manifest = structuredClone(manifestSource);
  const displayName = manifestName(name);
  manifest.display_information.name = displayName;
  manifest.features.bot_user.display_name = displayName;
  delete (manifest.oauth_config as Partial<SlackManifest["oauth_config"]>).redirect_urls;
  return manifest;
}
