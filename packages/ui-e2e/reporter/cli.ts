export interface FlagOptions {
  required: string[];
  optional?: string[];
  booleans?: string[];
}

export function parseFlags(argv: string[], options: FlagOptions): Map<string, string | true> {
  const optional = options.optional ?? [];
  const booleans = options.booleans ?? [];
  const known = new Set([...options.required, ...optional, ...booleans]);
  const values = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) {
      throw new Error(`Invalid argument near ${argument ?? "end of arguments"}`);
    }

    const key = argument.slice(2);
    if (!known.has(key) || values.has(key)) {
      throw new Error("Unknown or duplicate arguments were provided");
    }

    if (booleans.includes(key)) {
      values.set(key, true);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${argument}`);
    }
    values.set(key, value);
    index += 1;
  }

  for (const key of options.required) {
    if (!values.has(key)) throw new Error(`Missing required argument --${key}`);
  }

  return values;
}
