export function readPkgVersion(packageName: string): string | undefined {
  try {
    return require(`${packageName}/package.json`).version;
  } catch {
    return undefined;
  }
}
