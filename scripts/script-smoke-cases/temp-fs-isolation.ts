/* script-smoke
{
  "name": "scripts-smoke-temp-fs-isolation",
  "description": "Run the same inline script twice and verify fsMode=none gets isolated temp storage",
  "intent": "rich scripts api smoke temp fs isolation",
  "args": {},
  "expect": {
    "exitCode": 0,
    "result": {
      "firstExitCode": 0,
      "secondExitCode": 0,
      "firstSawExistingMarker": false,
      "secondSawExistingMarker": false,
      "tmpDirsDiffer": true
    }
  }
}
*/

const childSource = `
export default async () => {
  const proc = (globalThis as any).process;
  const bun = (globalThis as any).Bun;
  const tmpdir = proc.env.SWARM_SCRIPT_TMPDIR;
  const markerPath = tmpdir + "/fs-isolation-marker.txt";
  const existedBefore = await bun.file(markerPath).exists();
  await bun.write(markerPath, "marker");
  return { tmpdir, existedBefore, markerExistsAfterWrite: await bun.file(markerPath).exists() };
};
`;

export default async (_args: unknown, ctx: any) => {
  const first = await ctx.swarm.script_run({
    source: childSource,
    intent: "temp fs isolation child first",
    args: {},
  });
  const second = await ctx.swarm.script_run({
    source: childSource,
    intent: "temp fs isolation child second",
    args: {},
  });

  const firstRun = first?.data ?? {};
  const secondRun = second?.data ?? {};
  const firstResult = firstRun.result ?? {};
  const secondResult = secondRun.result ?? {};

  return {
    firstExitCode: firstRun.exitCode,
    secondExitCode: secondRun.exitCode,
    firstSawExistingMarker: firstResult.existedBefore,
    secondSawExistingMarker: secondResult.existedBefore,
    firstMarkerExistsAfterWrite: firstResult.markerExistsAfterWrite,
    secondMarkerExistsAfterWrite: secondResult.markerExistsAfterWrite,
    firstTmpdir: firstResult.tmpdir,
    secondTmpdir: secondResult.tmpdir,
    tmpDirsDiffer: firstResult.tmpdir !== secondResult.tmpdir,
  };
};
