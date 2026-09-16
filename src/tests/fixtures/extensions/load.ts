import type { ExtensionInstallBody } from "../../../types";

export async function loadBundleFixture(name: string): Promise<ExtensionInstallBody> {
  const directory = new URL(`./${name}/`, import.meta.url);
  const manifest = (await Bun.file(
    new URL("manifest.json", directory),
  ).json()) as ExtensionInstallBody["manifest"];
  const hooks = await Bun.file(new URL(manifest.assets.hooks, directory)).text();
  return { manifest, files: { [manifest.assets.hooks]: hooks } };
}
