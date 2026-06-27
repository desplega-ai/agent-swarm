export async function glob(pattern: string, cwd = process.cwd()): Promise<string[]> {
  const globber = new Bun.Glob(pattern);
  const matches: string[] = [];
  for await (const match of globber.scan({ cwd })) {
    matches.push(match);
  }
  return matches;
}
