import { seed } from "./seed";

async function main(): Promise<void> {
  const [apiUrl, apiKey, manifestPath] = Bun.argv.slice(2);
  if (!apiUrl || !apiKey || !manifestPath || Bun.argv.length !== 5) {
    throw new Error("Usage: bun boot/seed-cli.ts <apiUrl> <apiKey> <manifestPath>");
  }

  await Bun.write(manifestPath, JSON.stringify(await seed({ apiUrl, apiKey })));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
