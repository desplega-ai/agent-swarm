import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helperPath = join(import.meta.dir, "../../scripts/ensure-agent-browser.sh");
const tempRoots: string[] = [];

type Fixture = {
  root: string;
  stateDir: string;
  linkDir: string;
  browserPath: string;
  installCountPath: string;
  env: Record<string, string>;
};

async function createFixture(options: { browserPresent?: boolean; npmDelay?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ensure-agent-browser-"));
  tempRoots.push(root);

  const mockBin = join(root, "mock-bin");
  const stateDir = join(root, "state");
  const linkDir = join(root, "links");
  const playwrightRoot = join(root, "playwright");
  const browserPath = join(playwrightRoot, "chromium-1208/chrome-linux64/chrome");
  const installCountPath = join(root, "npm-installs");
  const mockNpmPath = join(mockBin, "npm");

  await mkdir(mockBin, { recursive: true });
  await mkdir(linkDir, { recursive: true });
  if (options.browserPresent !== false) {
    await mkdir(join(browserPath, ".."), { recursive: true });
    await writeFile(browserPath, "#!/bin/sh\nexit 0\n");
    await chmod(browserPath, 0o755);
  }

  await writeFile(
    mockNpmPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'install\\n' >> "$MOCK_NPM_COUNT"
sleep "\${MOCK_NPM_DELAY:-0}"
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
    continue
  fi
  shift
done
mkdir -p "$prefix/bin" "$prefix/lib/node_modules/agent-browser/bin"
cat > "$prefix/lib/node_modules/agent-browser/bin/agent-browser" <<'MOCK_CLI'
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  echo "agent-browser 0.33.1"
  exit 0
fi
if [ "\${1:-}" = "install" ]; then
  browser="$HOME/.agent-browser/browsers/chrome-mock/chrome"
  mkdir -p "$(dirname "$browser")"
  printf '#!/bin/sh\\nexit 0\\n' > "$browser"
  chmod 755 "$browser"
  exit 0
fi
printf 'browser=%s\\n' "\${AGENT_BROWSER_EXECUTABLE_PATH:-}"
MOCK_CLI
chmod 755 "$prefix/lib/node_modules/agent-browser/bin/agent-browser"
ln -s "$prefix/lib/node_modules/agent-browser/bin/agent-browser" "$prefix/bin/agent-browser"
`,
  );
  await chmod(mockNpmPath, 0o755);

  return {
    root,
    stateDir,
    linkDir,
    browserPath,
    installCountPath,
    env: {
      ...process.env,
      HOME: join(root, "home"),
      PATH: `${mockBin}:/usr/bin:/bin`,
      AGENT_BROWSER_BOOTSTRAP_ROOT: stateDir,
      AGENT_BROWSER_LINK_DIR: linkDir,
      AGENT_BROWSER_PLAYWRIGHT_ROOT: join(root, "missing-system-playwright"),
      PLAYWRIGHT_BROWSERS_PATH: playwrightRoot,
      MOCK_NPM_COUNT: installCountPath,
      MOCK_NPM_DELAY: options.npmDelay ?? "0",
    } as Record<string, string>,
  } satisfies Fixture;
}

async function runHelper(fixture: Fixture) {
  const process = Bun.spawn(["bash", helperPath], {
    env: fixture.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function installCount(fixture: Fixture): Promise<number> {
  const contents = await readFile(fixture.installCountPath, "utf8").catch(() => "");
  return contents.split("\n").filter(Boolean).length;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ensure-agent-browser", () => {
  test("installs the pinned CLI and binds the existing Playwright browser", async () => {
    const fixture = await createFixture();
    const result = await runHelper(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(
      `agent-browser ready: cli 0.33.1, browser ${fixture.browserPath}`,
    );
    expect(await installCount(fixture)).toBe(1);

    const wrapper = Bun.spawn([join(fixture.linkDir, "agent-browser"), "probe"], {
      env: fixture.env,
      stdout: "pipe",
    });
    expect(await new Response(wrapper.stdout).text()).toBe(`browser=${fixture.browserPath}\n`);
    expect(await wrapper.exited).toBe(0);
  });

  test("is warm and idempotent after the first install", async () => {
    const fixture = await createFixture();

    expect((await runHelper(fixture)).exitCode).toBe(0);
    expect((await runHelper(fixture)).exitCode).toBe(0);
    expect(await installCount(fixture)).toBe(1);
  });

  test("serializes concurrent cold starts", async () => {
    const fixture = await createFixture({ npmDelay: "0.2" });

    const [first, second] = await Promise.all([runHelper(fixture), runHelper(fixture)]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(await installCount(fixture)).toBe(1);
  });

  test("downloads Chrome into persisted storage when no browser exists", async () => {
    const fixture = await createFixture({ browserPresent: false });
    fixture.env.PLAYWRIGHT_BROWSERS_PATH = join(fixture.root, "missing-playwright");

    const result = await runHelper(fixture);
    const expectedBrowser = join(
      fixture.stateDir,
      "browser-home/.agent-browser/browsers/chrome-mock/chrome",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      `agent-browser ready: cli 0.33.1, browser ${expectedBrowser}`,
    );
    expect(await installCount(fixture)).toBe(1);
  });
});
