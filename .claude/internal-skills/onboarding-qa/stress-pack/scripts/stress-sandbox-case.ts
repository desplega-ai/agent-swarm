// One sandbox behaviour, run as a nested script by stress-sandbox.
type CaseArgs = {
  mode?: "cpu" | "sleep" | "throw" | "timeout" | "flood";
  ms?: number;
  kb?: number;
};

export default async function (args: CaseArgs | undefined, ctx: ScriptContext) {
  const g = await gate(ctx);
  if (!g.enabled) return { skipped: true };
  const started = Date.now();
  switch (args?.mode) {
    case "cpu": {
      // A hot loop for about `ms` milliseconds of CPU.
      const end = started + (args.ms ?? 2000);
      let spins = 0;
      let x = 7;
      while (Date.now() < end) {
        for (let i = 0; i < 200_000; i++) x = (x * 31 + i) % 1_000_003;
        spins++;
      }
      return { mode: "cpu", spins, x, ms: Date.now() - started };
    }
    case "sleep":
      await sleep(args.ms ?? 3000);
      return { mode: "sleep", ms: Date.now() - started };
    case "throw":
      throw new Error(`${EXPECTED}_THROW: this run fails on purpose`);
    case "timeout":
      // Longer than any script timeout. The sandbox must stop this run.
      await sleep(args.ms ?? 200_000);
      return { mode: "timeout", unexpected: "the run outlived its timeout" };
    case "flood": {
      // More output than the 1 MB stdout cap.
      const line = "stress pack stdout flood line. ".repeat(33).slice(0, 1023);
      const kb = args.kb ?? 1536;
      for (let i = 0; i < kb; i++) ctx.logger.log(line);
      return { mode: "flood", kb, ms: Date.now() - started };
    }
    default:
      return { mode: "none" };
  }
}
